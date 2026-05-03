# Architecture

The project uses Next.js with the existing root `app/` directory for routes and pages. Shared code lives in `src/`, database assets live in `database/`, and supporting design notes live in `docs/`.

The backend is organized as a distributed database-per-service architecture. Each major service owns its own Supabase project/database:

- Auth Service: Owns the Auth DB and user profiles.
- Events Service: Owns the Events DB, venues, events, and seats.
- Booking Service: Owns the Booking DB and reservation constraints.
- Payment Service: Owns the Payment DB and payment records.
- Ticket Service: Owns the Ticket DB and issued ticket state.

No service directly accesses another service database. Communication happens through Vercel API routes and future event messages. For example, the Booking service can validate event and seat data through the Events API, and the Ticket service can issue a ticket after receiving confirmation from the Booking and Payment services. This is distributed database design, not a centralized shared schema.

There are no cross-database foreign keys. Shared identifiers such as `user_id`, `event_id`, `seat_id`, and `reservation_id` are stored as UUID values and validated through service communication. Consistency is handled with API checks, eventual events, and local service-owned constraints.

The strongest local consistency rule is in the Booking DB: a partial unique index prevents more than one active reservation for the same event seat when the reservation is `reserved` or `confirmed`.

Upstash Redis may be added later for short-lived locks, reservation expiry workflows, or rate limiting, but the initial database protection is handled by the Booking DB.
