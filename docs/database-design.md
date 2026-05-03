# Database Design

The project now uses a true distributed database-per-service architecture. Each service owns its own Supabase project/database, and no service directly queries or writes another service database.

Services communicate through Vercel API routes and future events. IDs such as `user_id`, `event_id`, `seat_id`, and `reservation_id` are copied between services as UUID references, but they are not cross-database foreign keys.

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

RLS is enabled for `profiles`. Users can view their own profile and update their own `full_name`; admins can view all profiles and update user roles. Because admin role data lives in the same table, the Auth DB uses a `SECURITY DEFINER` helper function to avoid recursive RLS checks when determining whether the current user is an admin.

## Events Database

`venues` stores event locations. `events` stores event information and references venues within the Events DB. `event_seats` stores seats for each event and references events within the same database.

The Events DB may store `created_by` as a UUID from the Auth service, but it does not enforce a foreign key to the Auth DB. Admin validation must happen in the API layer by calling the Auth service or checking trusted auth claims.

Important constraints:

- `events.venue_id` can reference `venues.id` because both tables are owned by the Events service.
- `event_seats.event_id` can reference `events.id` because both tables are owned by the Events service.
- `event_seats` enforces `unique(event_id, seat_label)` so the same event cannot have duplicate seat labels.
- Event and seat statuses use text check constraints instead of shared enum types so each database stays independent.

RLS is enabled for `venues`, `events`, and `event_seats`. Authenticated users can read published events and their related seats and venues. Admin writes are checked with trusted admin claims in the JWT, while server-side service-role clients can perform trusted service operations.

## Booking Database

`reservations` stores seat holds and confirmed reservations:

- `user_id`: UUID copied from the Auth service.
- `event_id`: UUID copied from the Events service.
- `seat_id`: UUID copied from the Events service.
- `status`: `reserved`, `confirmed`, `expired`, or `cancelled`.
- `expires_at`: Required timestamp for releasing temporary holds.

There are no foreign keys to Auth or Events because those records live in separate databases. The Booking service must validate user, event, and seat data through APIs/events before creating reservations.

RLS is enabled for `reservations`. Users can view their own reservations and create reservations only for their own `user_id`. Admins can view and update all reservations, and trusted service-role API code can perform service operations.

## Active Reservation Unique Index

The Booking DB enforces the most important consistency rule with a partial unique index:

`reservations_one_active_per_event_seat_idx` on `(event_id, seat_id)` where `status` is `reserved` or `confirmed`.

This prevents two users from having active reservations for the same seat at the same event. Expired and cancelled rows remain as history but no longer block the seat. Even in a distributed system, this local database constraint gives the Booking service a strong source of truth for seat claims.

## Payment Database

`payments` stores payment attempts and results. It keeps `reservation_id` and `user_id` as UUID references from other services, without foreign keys.

The Payment service should verify reservation details through the Booking API before accepting or updating a payment. This project uses `fake_transaction_reference` for demos and must not store real card details.

RLS is enabled for `payments`. Users can view their own payments. Payment writes are reserved for admins or trusted service-role API code.

## Ticket Database

`tickets` stores issued tickets and ticket validation state. It keeps `user_id`, `event_id`, `seat_id`, and `reservation_id` as UUID references from other services, without foreign keys.

`ticket_code` is unique so each issued ticket has one validation code. Ticket creation should happen only after the Booking and Payment services confirm that a reservation is valid and paid.

RLS is enabled for `tickets`. Users can view their own tickets. Admins and trusted service-role API code can view or update ticket records for validation and administration.

## Cross-Service Consistency

Because there are no cross-database foreign keys, consistency is handled by service communication:

- APIs validate referenced IDs before performing writes.
- Events can notify other services about changes such as event cancellation, reservation confirmation, payment success, or ticket issuance.
- Each service owns its local invariants and data constraints.
- The Booking DB partial unique index prevents duplicate active seat reservations.

This design avoids direct database coupling and keeps service ownership clear, which is the core idea of database-per-service architecture.

Real secrets must not be stored in migrations, seed files, or documentation.
