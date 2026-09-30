FROM node:24.3.0-slim

# --no-install-recommends keeps the image smaller by avoiding extra dependencies.
# rm -rf /var/lib/apt/lists/* cleans up cached package lists to reduce image size.
# psql is needed for dumping and restoring the initial effects cache.
RUN apt-get update && \
    apt-get install -y --no-install-recommends postgresql-client && \
    rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm@9.7.1

WORKDIR /envio-indexer

COPY ./package.json ./package.json
COPY ./pnpm-lock.yaml ./pnpm-lock.yaml

RUN pnpm install --frozen-lockfile

COPY ./config.yaml ./config.yaml
COPY ./schema.graphql ./schema.graphql

# No abis/ dir: config.yaml uses inline human-readable event signatures (they take precedence over
# an abi_file_path per envio's own schema description), so there is no ABI file to copy here.

RUN pnpm envio codegen

COPY ./ ./

CMD pnpm envio start
