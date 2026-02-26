// ============================================================================
//  lib/errorHandler.js — Centralized Error Handling
//
//  ALL errors should use these classes for consistent API responses.
// ============================================================================


// ═══════════════════════════════════════════════════════════════════════════
//  ERROR CLASSES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Base application error
 */
class AppError extends Error {
  constructor(message, statusCode = 500, context = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.context = context;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation errors (400)
 */
class ValidationError extends AppError {
  constructor(message, context = {}) {
    super(message, 400, context);
  }
}

/**
 * External service errors (502)
 */
class ExternalServiceError extends AppError {
  constructor(message, serviceName = 'Unknown', context = {}) {
    super(`${serviceName}: ${message}`, 502, { ...context, service: serviceName });
  }
}

/**
 * Database errors (500)
 */
class DatastoreError extends AppError {
  constructor(message, operation = 'Unknown', context = {}) {
    super(`Datastore ${operation}: ${message}`, 500, { ...context, operation });
  }
}

/**
 * Authentication errors (401)
 */
class AuthError extends AppError {
  constructor(message, context = {}) {
    super(message, 401, context);
  }
}

/**
 * Configuration errors (500)
 */
class ConfigError extends AppError {
  constructor(message, context = {}) {
    super(message, 500, { ...context, type: 'configuration' });
  }
}

/**
 * Not found errors (404)
 */
class NotFoundError extends AppError {
  constructor(message, context = {}) {
    super(message, 404, context);
  }
}


// ═══════════════════════════════════════════════════════════════════════════
//  ERROR UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert error to HTTP response
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

  return {
    statusCode: 500,
    body: {
      status: 'error',
      error: 'InternalServerError',
      message: error.message || 'An unexpected error occurred'
    }
  };
}


// ═══════════════════════════════════════════════════════════════════════════
//  VALIDATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validate required parameters
 */
function validateRequired(params, requiredFields, context = {}) {
  const missing = requiredFields.filter(field => !params[field]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Missing required fields: ${missing.join(', ')}`,
      { ...context, missingFields: missing }
    );
  }
}

/**
 * Validate phone number
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


// ═══════════════════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  AppError,
  ValidationError,
  ExternalServiceError,
  DatastoreError,
  AuthError,
  ConfigError,
  NotFoundError,
  errorToResponse,
  validateRequired,
  validatePhoneNumber
};