# Envio Indexer Docker Setup

This repository contains a complete simple Docker setup for running an Envio blockchain indexer with PostgreSQL database and Hasura GraphQL engine.

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Basic understanding of blockchain indexing
- Your contract ABI files and configuration

### Running with Docker Compose

```bash
# Start all services (PostgreSQL, Hasura, and your indexer)
docker-compose up -d

# View logs
docker-compose logs -f envio-indexer

# Stop all services
docker-compose down -v
```

This will start:

- **PostgreSQL Database** on port `5433` (configurable via `ENVIO_PG_PORT`)
- **Hasura GraphQL Engine** on port `8080` (configurable via `HASURA_EXTERNAL_PORT`)
- **Your Envio Indexer** on port `8081`

### Running Only the Indexer (Docker)

If you have your own database setup:

```bash
# Build the indexer image
docker build -t my-envio-indexer .

# Run with your database connection
docker run -p 8081:8081 \
  -e ENVIO_PG_HOST=your-db-host \
  -e ENVIO_PG_PORT=5432 \
  -e ENVIO_PG_USER=your-user \
  -e ENVIO_PG_PASSWORD=your-password \
  -e ENVIO_PG_DATABASE=your-database \
  my-envio-indexer
```

## Configuration for Your Own Indexer

### 1. Update Contract Configuration

Edit `config.yaml`:

```yaml
name: your_indexer_name
description: Your indexer description
networks:
  - id: 1 # Your network ID (1 for Ethereum mainnet, etc.)
    rpc_config:
      url: https://your-rpc-endpoint
    start_block: 0 # Block to start indexing from
    contracts:
      - name: YourContract
        abi_file_path: abis/your-contract-abi.json
        address: ["0xYourContractAddress"]
        handler: ./src/EventHandlers.res.js
        events:
          - name: "YourEvent"
```

### 2. Add Your Contract ABI

Place your contract ABI file in the `abis/` directory:

```bash
# Example
cp your-contract-abi.json abis/
```

### 3. Define Your Schema

Edit `schema.graphql` to define your entities:

```graphql
type YourEntity {
  id: ID!
  field1: String!
  field2: Int!
  # Add your fields here
}
```

### 4. Implement Event Handlers

Edit `src/EventHandlers.res` to handle your contract events:

```rescript
// Your event handling logic here
```

### 5. Rebuild and Deploy

```bash
# Rebuild with your changes
docker-compose up --build -d

# Or just rebuild the indexer
docker-compose up --build envio-indexer
```

## Environment Variables

| Variable                      | Default     | Description              |
| ----------------------------- | ----------- | ------------------------ |
| `ENVIO_PG_PORT`               | `5433`      | External PostgreSQL port |
| `ENVIO_POSTGRES_PASSWORD`     | `testing`   | Database password        |
| `ENVIO_PG_USER`               | `postgres`  | Database user            |
| `ENVIO_PG_DATABASE`           | `envio-dev` | Database name            |
| `HASURA_EXTERNAL_PORT`        | `8080`      | External Hasura port     |
| `HASURA_GRAPHQL_ADMIN_SECRET` | `testing`   | Hasura admin secret      |
| `LOG_LEVEL`                   | `trace`     | Indexer log level        |
| `TUI_OFF`                     | `true`      | Disable terminal UI      |

## Accessing Services

- **Hasura Console**: http://localhost:8080
- **Your Indexer**: http://localhost:8081
- **PostgreSQL**: localhost:5433

## Troubleshooting

### Common Issues

1. **Port conflicts**: Change ports in `.env` file
2. **Permission issues**: Ensure Docker has proper permissions
3. **Memory issues**: Adjust resource limits in `docker-compose.yaml`

### Useful Commands

```bash
# View indexer logs
docker-compose logs -f envio-indexer

# Restart just the indexer
docker-compose restart envio-indexer

# Clean up and restart everything
docker-compose down -v && docker-compose up -d

# Shell into the indexer container
docker-compose exec envio-indexer /bin/bash
```

---

## Indexer Requirements

The following files are required to use the Indexer:

- Configuration (defaults to `config.yaml`)
- GraphQL Schema (defaults to `schema.graphql`)
- Event Handlers (defaults to `src/EventHandlers.res`)
