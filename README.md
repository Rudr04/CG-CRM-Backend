# Cloud Function Setup

## Pre-requisites
1. Enable Firestore in GCP Console:
   - Go to console.cloud.google.com → your project
   - Search "Firestore" → Create Database
   - Select NATIVE MODE (not Datastore)
   - Region: asia-south1

2. Ensure your service account has these roles:
   - Cloud Datastore User (for Firestore)
   - Editor (usually already has this)

## Deploy
```bash
# From this folder:
cp .env.example .env
# Fill in your values in .env

# Deploy to GCP
gcloud functions deploy cosmoguru-webhook \
  --runtime nodejs20 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point webhook \
  --region asia-south1 \
  --set-env-vars SPREADSHEET_ID=xxx,WATI_TENANT_ID=xxx,WATI_BEARER_TOKEN=xxx,WATI_BASE_URL=xxx,FIREBASE_DATABASE_URL=xxx,FIREBASE_SECRET=xxx
```

## Folder structure
```
cloud-function/
├── index.js                    # Main entry point + routing
├── config.js                   # All configuration
├── package.json                # Dependencies
├── .env.example                # Environment template
├── .gcloudignore               # Deploy ignore list
├── handlers/
│   ├── contactHandler.js       # New contacts, keywords, manual entry
│   ├── formHandler.js          # WhatsApp form submissions
│   ├── paymentHandler.js       # Payment processing
│   └── syncHandler.js          # Sheet→Firestore real-time sync (NEW)
├── services/
│   ├── sheetsService.js        # Google Sheets CRUD (+ Firestore parallel writes)
│   ├── firestoreService.js     # Firestore CRM database (NEW)
│   ├── firebaseService.js      # Firebase RTDB whitelist
│   ├── watiService.js          # WhatsApp API
│   └── smartfloService.js      # Smartflo calling API
└── utils/
    └── helpers.js              # Phone matching, dates, fuzzy search
```

## Test
1. Send a test webhook: curl -X POST YOUR_FUNCTION_URL -H "Content-Type: application/json" -d '{"eventType":"Manually_Entry","senderName":"Test","waId":"919999999999","source":"Manual Entry","product":"CGI","team":"Not Assigned"}'
2. Check Sheet5: new row should appear
3. Check Firestore Console: leads/9999999999 should exist
4. Check logs: gcloud functions logs read cosmoguru-webhook --region asia-south1
