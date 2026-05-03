# Auth Service

The Auth Service handles user registration, login, JWT token generation, and basic profile verification.

## Run locally

```bash
cd services/auth-service
npm install
copy .env.example .env
npm run dev
```

## Endpoints

- `GET /health`
- `POST /register`
- `POST /login`
- `GET /profile`
