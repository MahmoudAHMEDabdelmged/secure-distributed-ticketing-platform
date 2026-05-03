# Secure Distributed Ticketing Platform

A college project for building a secure event ticketing platform with distributed booking concepts, seat reservations, ticket issuance, and administrative event management.

## Tech Stack

- Next.js
- TypeScript
- Tailwind CSS
- Neon PostgreSQL
- Vercel
- Optional Upstash Redis for distributed locking and reservation caching

## Main Features

- Event browsing and event details
- Seat selection and temporary reservation flow
- Secure booking confirmation
- Ticket generation and ticket validation concepts
- Admin event and inventory management
- Neon-backed service databases
- Distributed-system notes for reservation expiry, concurrency, and scaling

## Project Architecture Summary

The app keeps the existing root `app/` directory for Next.js routes and pages. Shared application code is organized under `src/`, with reusable UI components, service modules, domain helpers, security utilities, shared types, and configuration. Database assets live under `database/`, while project planning and design notes live under `docs/`.

## Folder Structure Summary

- `app/`: Existing Next.js app routes and UI entry points.
- `src/components/`: Reusable UI components grouped by platform area.
- `src/services/`: Application service modules for data and workflow operations.
- `src/lib/`: Shared libraries for Neon database access, booking logic, security, and utilities.
- `src/types/`: Shared TypeScript type definitions.
- `src/config/`: Centralized application configuration.
- `database/`: Migrations, seed data, and database diagrams.
- `docs/`: Architecture, security, API, database, and demo documentation.
- `tests/`: Future automated tests.

## Security Note

Real secrets must never be committed to the repository. Use `.env.example` as a template, create a local `.env.local` for development, and keep production secrets in Vercel or the relevant deployment secret store.

## Setup Steps

1. `npm install`
2. Copy `.env.example` to `.env.local`
3. `npm run dev`
