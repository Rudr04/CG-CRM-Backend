/**
 * Error Handler Module
 * Provides standardized error classes and HTTP status code mapping for the webhook
 */

/**
 * Base custom error class with error context
 */
class AppError extends Error {
  constructor(message, statusCode = 500, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.context = context;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      error: this.name,
      message: this.message,
      statusCode: this.statusCode,
      context: this.context,
      timestamp: this.timestamp
    };
  }
}

/**
 * Validation errors (400) - Invalid input data
 */
class ValidationError extends AppError {
  constructor(message, context = {}) {
    super(message, 400, context);
  }
}

/**
 * External service errors (502) - API failures (WATI, Smartflo, Firebase, etc.)
 */
class ExternalServiceError extends AppError {
  constructor(message, serviceName = 'Unknown', context = {}) {
    super(`${serviceName} error: ${message}`, 502, { ...context, service: serviceName });
  }
}

/**
 * Datastore/Database errors (500) - Firestore, Datastore, Google Sheets failures
 */
class DatastoreError extends AppError {
  constructor(message, operation = 'Unknown', context = {}) {
    super(`Datastore ${operation} failed: ${message}`, 500, { ...context, operation });
  }
}

/**
 * Authentication/Authorization errors (401/403)
 */
class AuthError extends AppError {
  constructor(message, context = {}) {
    super(message, 401, context);
  }
}

/**
 * Configuration errors (400) - Missing or invalid environment variables
 */
class ConfigError extends AppError {
  constructor(message, context = {}) {
    super(message, 400, { ...context, type: 'configuration' });
  }
}

/**
 * Map error to HTTP response object
 */
function errorToResponse(error) {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      body: {
        status: 'error',
        error: error.name,
        message: error.message,
        context: error.context
      }
    };
  }

  // Unknown error - return 500
  return {
    statusCode: 500,
    body: {
      status: 'error',
      error: 'InternalServerError',
      message: error.message || 'An unexpected error occurred'
    }
  };
}

/**
 * Wrap async handler to catch errors and format response
 */
function asyncHandler(fn) {
  return async (req, res) => {
    try {
      return await fn(req, res);
    } catch (error) {
      console.error('Unhandled error:', error);
      const { statusCode, body } = errorToResponse(error);
      return res.status(statusCode).json(body);
    }
  };
}

/**
 * Validate required parameters
 */
function validateRequired(params, requiredFields, context = {}) {
  const missing = [];
  for (const field of requiredFields) {
    if (!params[field]) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields: ${missing.join(', ')}`,
      { ...context, missingFields: missing }
    );
  }
}

/**
 * Validate phone number format (10 digits)
 */
function validatePhoneNumber(phone, context = {}) {
  if (!phone) {
    throw new ValidationError('Phone number is required', context);
  }
  const cleaned = phone.toString().replace(/\D/g, '');
  if (cleaned.length < 10) {
    throw new ValidationError(
      `Invalid phone number: ${phone}. Expected at least 10 digits.`,
      { ...context, phoneNumber: phone }
    );
  }
  return cleaned;
}

module.exports = {
  // Error classes
  AppError,
  ValidationError,
  ExternalServiceError,
  DatastoreError,
  AuthError,
  ConfigError,

  // Utilities
  errorToResponse,
  asyncHandler,
  validateRequired,
  validatePhoneNumber
};
