insert into public.venues (id, name, city, address, capacity)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'College Main Auditorium',
    'Cairo',
    'Campus Central Building',
    300
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'Engineering Hall',
    'Cairo',
    'Faculty of Engineering',
    120
  );

insert into public.events (id, venue_id, title, description, event_date, image_url, status)
values
  (
    '33333333-3333-3333-3333-333333333333',
    '11111111-1111-1111-1111-111111111111',
    'Distributed Systems Tech Talk',
    'A sample published event for demonstrating secure seat reservation and ticket validation.',
    now() + interval '14 days',
    null,
    'published'
  ),
  (
    '44444444-4444-4444-4444-444444444444',
    '22222222-2222-2222-2222-222222222222',
    'Cybersecurity Workshop',
    'A draft admin-managed workshop for testing unpublished event access rules.',
    now() + interval '21 days',
    null,
    'draft'
  );

insert into public.event_seats (event_id, seat_label, section, price, status)
values
  ('33333333-3333-3333-3333-333333333333', 'A1', 'A', 150.00, 'available'),
  ('33333333-3333-3333-3333-333333333333', 'A2', 'A', 150.00, 'available'),
  ('33333333-3333-3333-3333-333333333333', 'A3', 'A', 150.00, 'available'),
  ('33333333-3333-3333-3333-333333333333', 'B1', 'B', 100.00, 'available'),
  ('33333333-3333-3333-3333-333333333333', 'B2', 'B', 100.00, 'available'),
  ('33333333-3333-3333-3333-333333333333', 'B3', 'B', 100.00, 'available'),
  ('44444444-4444-4444-4444-444444444444', 'A1', 'A', 75.00, 'available'),
  ('44444444-4444-4444-4444-444444444444', 'A2', 'A', 75.00, 'available');
