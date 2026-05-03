# API Gateway

The API Gateway is the single entry point for backend microservices. It applies basic security controls, verifies JWT tokens for protected routes, rate-limits requests, and proxies Auth Service routes.

## Run locally

```bash
cd services/api-gateway
npm install
copy .env.example .env
npm run dev
```

## Endpoints

- `GET /health`
- `GET /secure-test`
- `/auth/*` proxied to the Auth Service
