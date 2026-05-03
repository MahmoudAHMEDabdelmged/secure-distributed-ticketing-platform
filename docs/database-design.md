# Database Design

The project uses a true distributed database-per-service architecture hosted on Neon PostgreSQL. Each service owns its own independent Neon database, and no service directly queries or writes another service database.

Services communicate through Next.js/Vercel API routes and future events. IDs such as `user_id`, `event_id`, `seat_id`, and `reservation_id` are copied between services as UUID references, but they are not cross-database foreign keys.

Connection strings are stored only in local `.env.local` files or Vercel environment variables. They must never be committed. The frontend never connects directly to Neon; only server-side API routes and server-only modules may use database connection strings.

## Service Databases

- Auth Database: Owns user profile metadata and role information.
- Events Database: Owns venues, events, and event seats.
- Booking Database: Owns reservations and duplicate-booking protection.
- Payment Database: Owns payment records for reservations.
- Ticket Database: Owns issued tickets and ticket validation state.

## Auth Database

`profiles` stores public user metadata:

- `id`: UUID primary key, matching the authenticated user ID.
- `email`: Unique email address.
- `full_name`: User display name.
- `role`: `user` or `admin`, enforced with a check constraint.
- `created_at` and `updated_at`: Profile timestamps.

Authorization is enforced in the Auth Service API layer. Users may view their own profile and update their own `full_name`; admins may view all profiles and update user roles.

## Events Database

`venues` stores event locations. `events` stores event information and references venues within the Events DB. `event_seats` stores seats for each event and references events within the same database.

The Events DB may store `created_by` as a UUID from the Auth service, but it does not enforce a foreign key to the Auth DB. Admin validation must happen in the API layer by calling the Auth service or checking trusted auth claims.

Important constraints:

- `events.venue_id` can reference `venues.id` because both tables are owned by the Events service.
- `event_seats.event_id` can reference `events.id` because both tables are owned by the Events service.
- `event_seats` enforces `unique(event_id, seat_label)` so the same event cannot have duplicate seat labels.
- Event and seat statuses use text check constraints instead of shared enum types so each database stays independent.

Authorization is enforced in the Events Service API layer. Authenticated users can read published events and their related seats and venues. Admin-only event management is handled by protected server-side routes.

## Booking Database

`reservations` stores seat holds and confirmed reservations:

- `user_id`: UUID copied from the Auth service.
- `event_id`: UUID copied from the Events service.
- `seat_id`: UUID copied from the Events service.
- `status`: `reserved`, `confirmed`, `expired`, or `cancelled`.
- `expires_at`: Required timestamp for releasing temporary holds.

There are no foreign keys to Auth or Events because those records live in separate databases. The Booking service must validate user, event, and seat data through APIs/events before creating reservations.

Authorization is enforced in the Booking Service API layer. Users can view their own reservations and create reservations only for their own `user_id`; admin routes can view and update all reservations.

## Active Reservation Unique Index

The Booking DB enforces the most important consistency rule with a partial unique index:

`reservations_one_active_per_event_seat_idx` on `(event_id, seat_id)` where `status` is `reserved` or `confirmed`.

This prevents two users from having active reservations for the same seat at the same event. Expired and cancelled rows remain as history but no longer block the seat. Even in a distributed system, this local database constraint gives the Booking service a strong source of truth for seat claims.

## Payment Database

`payments` stores payment attempts and results. It keeps `reservation_id` and `user_id` as UUID references from other services, without foreign keys.

The Payment service should verify reservation details through the Booking API before accepting or updating a payment. This project uses `fake_transaction_reference` for demos and must not store real card details.

Authorization is enforced in the Payment Service API layer. Users can view their own payments, while payment writes are performed by protected server-side routes.

## Ticket Database

`tickets` stores issued tickets and ticket validation state. It keeps `user_id`, `event_id`, `seat_id`, and `reservation_id` as UUID references from other services, without foreign keys.

`ticket_code` is unique so each issued ticket has one validation code. Ticket creation should happen only after the Booking and Payment services confirm that a reservation is valid and paid.

Authorization is enforced in the Ticket Service API layer. Users can view their own tickets, while protected server-side routes manage ticket validation and administration updates.

## Cross-Service Consistency

Because there are no cross-database foreign keys, consistency is handled by service communication:

- APIs validate referenced IDs before performing writes.
- Events can notify other services about changes such as event cancellation, reservation confirmation, payment success, or ticket issuance.
- Each service owns its local invariants and data constraints.
- The Booking DB partial unique index prevents duplicate active seat reservations.

This design avoids direct database coupling and keeps service ownership clear, which is the core idea of database-per-service architecture.

Real secrets and real Neon connection strings must not be stored in migrations, seed files, or documentation.
