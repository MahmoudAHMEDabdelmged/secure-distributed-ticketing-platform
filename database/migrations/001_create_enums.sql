create extension if not exists "pgcrypto";

create type public.user_role as enum ('user', 'admin');
create type public.event_status as enum ('draft', 'published', 'cancelled');
create type public.seat_status as enum ('available', 'reserved', 'sold');
create type public.reservation_status as enum ('reserved', 'confirmed', 'expired', 'cancelled');
create type public.payment_status as enum ('pending', 'success', 'failed');
create type public.ticket_status as enum ('active', 'used', 'cancelled');
