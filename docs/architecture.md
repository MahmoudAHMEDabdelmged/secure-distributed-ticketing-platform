# Architecture

The project uses Next.js with the existing root `app/` directory for routes and pages. Shared code lives in `src/`, database assets live in `database/`, and supporting design notes live in `docs/`.

Supabase is planned for authentication, database storage, and server-side data access. Upstash Redis may be added later for distributed reservation locks, short-lived seat holds, or rate-limiting support.
