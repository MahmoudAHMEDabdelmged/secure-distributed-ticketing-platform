# Database Design

The platform uses Supabase Postgres with Supabase Auth and Row Level Security. Application user accounts live in `auth.users`, while project-specific user metadata lives in the public `profiles` table.

## Tables

- `profiles`: Stores public user metadata, including full name, email, and role. Each profile is tied directly to one `auth.users` row.
- `venues`: Stores event locations such as halls, auditoriums, and campus spaces.
- `events`: Stores event details, event date, publication status, optional image URL, venue reference, and creator reference.
- `event_seats`: Stores the sellable seats for each event, including label, section, price, and current seat status.
- `reservations`: Stores temporary or confirmed seat holds for users. Each reservation links a user, event, and event seat with an expiry timestamp.
- `payments`: Stores payment records for reservations. This project uses fake transaction references for demos and must not store real card data.
- `tickets`: Stores issued ticket records, ticket codes, optional QR payloads, and ticket status.
- `audit_logs`: Stores security and administration events such as admin changes, ticket validation attempts, or booking workflow actions.

## Relationships

- `profiles.id` references `auth.users.id` and is deleted when the auth user is deleted.
- `events.venue_id` references `venues.id` and is set to null if the venue is removed.
- `events.created_by` references `profiles.id`.
- `event_seats.event_id` references `events.id` and is deleted with the event.
- `reservations.user_id` references `profiles.id`.
- `reservations.event_id` references `events.id`.
- `reservations.seat_id` references `event_seats.id`.
- `payments.reservation_id` references `reservations.id`.
- `payments.user_id` references `profiles.id`.
- `tickets.user_id`, `tickets.event_id`, `tickets.seat_id`, and `tickets.reservation_id` link each issued ticket back to its owner, event, seat, and reservation.
- `audit_logs.actor_user_id` references `profiles.id` and is set to null if the user is deleted.

## Important Constraints

- `event_seats` has a unique constraint on `(event_id, seat_label)` so an event cannot contain duplicate seat labels.
- `tickets.ticket_code` is unique so each ticket can be validated by a distinct code.
- `reservations` and `tickets` include composite foreign keys for `(seat_id, event_id)` to prevent linking a seat from one event to a reservation or ticket for a different event.
- Status columns use enum types to keep workflow states explicit and consistent.
- `expires_at` on `reservations` is required so temporary seat holds can be released.

## Active Reservation Unique Index

The `reservations_one_active_per_event_seat_idx` partial unique index prevents two active reservations from claiming the same seat for the same event. It applies only when `status` is `reserved` or `confirmed`, which means historical rows with `expired` or `cancelled` status can remain in the database without blocking future bookings.

This is the core database-level protection against duplicate active bookings. Even if two users try to reserve the same seat at the same time, Postgres will allow only one active reservation for that `(event_id, seat_id)` pair.

## RLS Security Rules

RLS is enabled on every public table. The migration adds a `public.is_admin()` helper that checks whether the current authenticated user has an admin profile.

- `profiles`: Users can view their own profile and update their own `full_name`. Admins can view all profiles.
- `venues`: Authenticated users can read venues connected to published events. Admins can insert, update, and delete venues.
- `events`: Authenticated users can read published events. Admins can insert, update, and delete events.
- `event_seats`: Authenticated users can read seats for published events. Admins can insert, update, and delete seats.
- `reservations`: Users can view and create only their own reservations. Admins can view, update, and delete reservations.
- `payments`: Users can view their own payments. Admins can insert and update payments. Supabase service-role access can also be used from trusted server code because it bypasses RLS.
- `tickets`: Users can view their own tickets. Admins can view all tickets.
- `audit_logs`: Admins can view audit logs. Normal users have no audit log read policy.

Real secrets must not be stored in these migrations or seed files.
