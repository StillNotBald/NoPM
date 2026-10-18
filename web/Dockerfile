# NoPM — self-host Docker image (R-88). Multi-stage build producing a small
# runtime image via Next.js "standalone" output (see next.config.ts).
#
# Supabase (Postgres + Auth + RLS) is NOT included here — it stays hosted
# (Supabase Cloud) or you run `supabase start` separately. See
# docs/SELF_HOSTING.md. This image is the Next.js app only.
#
# Build (from the web/ directory):
#   docker build -t nopm-web .
#
# NEXT_PUBLIC_* vars are inlined into the client JS bundle at BUILD time, not
# read at runtime — that's a Next.js constraint, not a NoPM one. If you know
# your real Supabase project at build time, pass it:
#   docker build -t nopm-web \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
#     .
# Otherwise the placeholder defaults below let the image build successfully;
# rebuild with real values before you actually deploy it (or bake the image
# per-environment in CI). Every other required var (SUPABASE_SERVICE_ROLE_KEY,
# NOPM_ENCRYPTION_KEY, etc.) is server-only and read at RUNTIME from the
# container's real environment — see docker-compose.yml / web/.env.example.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the "prepare" script installs local git hooks (irrelevant
# and unavailable inside a container build — no .git directory is copied in).
RUN npm ci --ignore-scripts

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time-only placeholders (see note above) — safe, non-secret defaults.
# Server-only vars (SUPABASE_SERVICE_ROLE_KEY, NOPM_ENCRYPTION_KEY, ...) are
# read lazily at request time (see web/src/lib/supabase/admin.ts,
# web/src/lib/crypto.ts), so `next build` does not need them at all — only
# NEXT_PUBLIC_* vars, which get inlined into the client bundle here.
ARG NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
