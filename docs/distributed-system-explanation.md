# Distributed System Explanation

This project uses a true distributed database-per-service architecture. The Auth, Events, Booking, Payment, and Ticket services each own their own Neon PostgreSQL database.

No service directly reads or writes another service database. Services communicate through Next.js/Vercel API routes and future event messages. This keeps ownership clear and avoids tight database coupling between services, so the system is distributed rather than centralized.

The frontend never connects directly to Neon. Connection strings live only in `.env.local` during local development or in Vercel environment variables during deployment, and only API routes or server-only modules use them.

## Service Ownership

- Auth Service owns users, profile data, and roles.
- Events Service owns venues, events, and seats.
- Booking Service owns reservations and seat-hold consistency.
- Payment Service owns payment attempts and payment status.
- Ticket Service owns issued tickets and ticket validation state.

IDs are shared between services as values, not foreign keys. For example, a reservation stores `user_id`, `event_id`, and `seat_id`, but those IDs are validated through Auth and Events service APIs instead of database constraints.

## Consistency Model

Cross-service consistency is handled by service communication:

- The Booking API checks that the user, event, and seat are valid before creating a reservation.
- The Payment API checks that the reservation exists and belongs to the user before recording payment.
- The Ticket API creates tickets only after booking and payment success are confirmed.
- Future event messages can notify services when an event is cancelled, a reservation expires, a payment succeeds, or a ticket is issued.

This means the system may use eventual consistency between services, while each service still enforces strong local rules in its own database.

## Duplicate Booking Protection

The Booking DB prevents duplicate active seat reservations with a partial unique index on `(event_id, seat_id)` where status is `reserved` or `confirmed`.

That index means only one active reservation can exist for the same event seat. If another request tries to reserve the same seat at the same time, Postgres rejects the duplicate active reservation. Expired and cancelled reservations do not block future bookings.

## Why No Cross-Database Foreign Keys

Foreign keys work inside a single database. In this architecture, each service has a separate Neon PostgreSQL database, so cross-database foreign keys are intentionally not used.

Instead, the application relies on APIs/events to validate references and coordinate state changes. This makes the design closer to real distributed systems, where services own their data and communicate through contracts rather than shared tables.
