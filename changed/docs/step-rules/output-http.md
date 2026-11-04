# Owner-scoped output routes

Covers: route:GET:/api/documents/:documentId/outputs/:revisionId/document, route:GET:/api/documents/:documentId/outputs/:revisionId/text, route:GET:/api/documents/:documentId/outputs/:revisionId/images/:figureId, route:GET:/api/documents/:documentId/outputs/:revisionId/report, route:GET:/api/documents/:documentId/outputs/:revisionId/rating, route:PUT:/api/documents/:documentId/outputs/:revisionId/rating, route:DELETE:/api/documents/:documentId/outputs/:revisionId/rating

Authenticate every operation and resolve the owner's published revision through
OutputStore. Reads resolve the owner with `DocumentStore.readableOwner`, so
shared examples are readable by every signed-in user; a non-owner's rating read
returns `null`, and rating writes use the session user and return not-found for
examples. Canonical JSON and reports use their shared schemas. Text returns
the exact normalized UTF-8 bytes; image IDs resolve only through that revision's
figure manifest. No request supplies a filesystem path. Foreign, missing, and
expired revisions are unavailable. Private responses use no-store and nosniff.

Rating mutations require the configured same origin and a bounded JSON body;
one rating is replaceable or removable. GETs never mutate processing or submit
provider requests. Errors are concise and never expose provider wire data.

ZIP delivery is implemented separately against the same allowlisted manifest.
The manager verifies downloaded bytes, ownership, rating persistence, and every
visible action in Chrome after integration.
