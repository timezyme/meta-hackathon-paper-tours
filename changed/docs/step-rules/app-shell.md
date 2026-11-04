# Application shell

Covers: route:GET:/, route:GET:/sign-in, route:GET:/documents/:documentId, route:GET:/app/assets/:filename

The shell serves sign-in, the authenticated upload/dashboard, document processing states, and the saved-output reader. Owner-authorized APIs supply private data; the static shell contains none.

1. `makeAmuseMe` is the only Mastra composition point. The guarded listener binds to `127.0.0.1` and defaults to port 4180. Validate `AMUSEME_PORT` as an integer from 1024 through 65535. Keep stock Studio at `/admin` and its APIs at `/admin/api`; apply the outer access rules in [HTTP access](http-access.md) before every route.
2. GET `/`, `/sign-in`, and valid `/documents/:documentId` paths read the same built React index, containing no private document data. GET `/app/assets/:filename` reads only a single validated Vite asset filename ending in `.js`, `.css`, `.svg`, `.woff2`, `.png`, or `.ico`. Validate filenames before filesystem access. Never serve arbitrary repository files or private artifacts.
3. Vite builds only `src/app/` into `src/mastra/public/app/`. Mastra copies that output to its runtime directory. Generated assets are ignored. The prototype remains separate.
4. Effect owns file reads through `FileSystem`. The Mastra callback is the Promise boundary and passes the request cancellation signal. Each read has a five-second deadline. There are no retries or persistent resources.
5. Invalid or missing assets return 404. A missing index returns 503 with a safe message. Other filesystem failures return 500 and are logged server-side. A deadline returns 503. A successful response carries its correct content type and `nosniff`; the index is not cached.
6. The browser resolves the current session before showing user-specific navigation or documents. Upload availability and limits come from the document API; queued/running states refresh until terminal, and a published current revision opens the reader. Pathname changes and session refresh events revalidate authentication; reader page-query changes preserve the session and loaded output. Only admins see the Studio link; server authorization protects Studio independently of navigation. Follow [Application UI](application-ui.md) and [Document reader](document-reader.md) for browser behavior.
7. Tests verify route registration, asset types and serving failures through fake filesystem services. Guard integration tests use the actual Mastra route factory. Browser checks verify the production shell, built assets, sign-in/session behavior, and stock Studio. Loopback HTTP is a local development transport, not production readiness.

The Mastra constructor and React DOM mount are framework startup boundaries. Effect execution returns Promises only from route callbacks. Browser test callbacks use Effect to adapt Playwright's Promise API. Vite and Playwright configuration files are framework configuration, not application I/O.

The Mastra skill is copied without changes from the normalization source at revision `7579d048356374581dc7bca02691dc6a9a26a769`. Its Apache-2.0 metadata and all supporting references and scripts remain together. Server code uses installed public APIs rather than copying the normalization source's Studio branding or chat routes.

Current upload disclosure identifies Meta page extraction/checking and text/figure processing. Reader attempt details show the nested extraction model configuration and its available versioned public prompt. Historical extraction receipts without a model retain their saved provider/version display. The immutable version-1 extraction prompt stays in its historical backend module; its public UI template remains unavailable.

The reader calls exported images “source images.” They may be crops of rendered pages; the interface must not imply they are the PDF's native embedded images.
