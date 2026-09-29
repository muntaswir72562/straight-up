# --- Stage 1: Install dependencies ---
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --ignore-scripts

# --- Stage 2: Build the Next.js app ---
FROM node:20-slim AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# postinstall copies pdfjs worker + downloads opencv.js
RUN npm run postinstall
RUN npm run build

# --- Stage 3: Production image with Node + Python ---
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Install Python and pip
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      libgl1 \
      libglib2.0-0 && \
    rm -rf /var/lib/apt/lists/* && \
    ln -sf /usr/bin/python3 /usr/bin/python

# Install Python dependencies
COPY scripts/requirements.txt /tmp/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt && \
    rm /tmp/requirements.txt

# Copy standalone output from builder
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy Python scripts (needed at runtime for PDF processing)
COPY --from=builder /app/scripts/straighten_pdf.py ./scripts/
COPY --from=builder /app/scripts/clean_pdf.py ./scripts/
COPY --from=builder /app/scripts/fullfix_pdf.py ./scripts/
COPY --from=builder /app/scripts/manualfix_pdf.py ./scripts/

EXPOSE 3000

CMD ["node", "server.js"]
