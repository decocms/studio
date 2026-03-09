# Docker Compose - Deco MCP Mesh

This is the local version using Docker Compose, to speed up your testing with the Deco MCP Mesh application directly on your computer or server.

## 📋 Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start---get-started-in-4-steps)
- [Configuration](#configuration)
- [Using PGlite (Default)](#using-pglite-default)
- [Using PostgreSQL](#using-postgresql)
- [Authentication Configuration](#authentication-configuration-auth-configjson)
- [Security](#security)
- [Monitoring](#monitoring)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Backup and Restore](#backup-and-restore)

## 🎯 Overview

- ✅ **PGlite by default** - Embedded PostgreSQL via WASM, works immediately without additional configuration
- ✅ **PostgreSQL optional** - Configure via environment variable for production
- ✅ **Data persistence** - Docker volume to keep data between restarts
- ✅ **Health checks** - Automatic application health monitoring
- ✅ **Configuration via variables** - All configurations via `.env`

## 📦 Prerequisites

- Docker 20.10+
- Docker Compose 2.0+
- (Optional) PostgreSQL if you want to use external database

## ⚡ Quick Start - Get Started in 4 Steps

The fastest way to test the application:

```bash
# 1. Configure environment variables
# Edit .env and configure BETTER_AUTH_SECRET (required)
# Generate a secret: openssl rand -base64 32
cp conf-examples/env.example .env

# 2. Configure authentication
cp conf-examples/auth-config.json.example auth-config.json

# 3. Start the application
docker compose up -d

# 4. Access
open http://localhost:3000
```

These configurations are all you need to start testing with MCP-MESH. If you need other options, check the information in the following sections.

### 📝 Minimum Configuration

The `.env` file needs at least:

```bash
BETTER_AUTH_SECRET=your_generated_secret_here
```

All other variables have default values that work for local testing.

## ⚙️ Configuration

### .env File

The `.env` file contains all configurations.

Main variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `IMAGE_REPOSITORY` | `ghcr.io/decocms/mesh/mesh` | Image repository |
| `IMAGE_TAG` | `latest` | Image tag |
| `PORT` | `3000` | Port exposed on host |
| `NODE_ENV` | `production` | Node.js environment |
| `BETTER_AUTH_URL` | `http://localhost:3000` | URL for authentication |
| `BASE_URL` | `http://localhost:3000` | Application base URL |
| `BETTER_AUTH_SECRET` | **required** | Authentication secret |
| `DATABASE_URL` | `file:///app/data/mesh.pglite` | Database URL (PGlite or PostgreSQL) |

## 💾 Using PGlite (Default)

PGlite (embedded PostgreSQL via WASM) is the default and requires no additional configuration:

```bash
# .env
DATABASE_URL=file:///app/data/mesh.pglite
```

Data will be persisted in the Docker volume `mesh-data` and kept between restarts.

**Advantages:**
- ✅ Zero configuration
- ✅ Works immediately
- ✅ Full PostgreSQL compatibility
- ✅ Ideal for development and testing

**Limitations:**
- ⚠️ Only 1 instance (not horizontally scalable)
- ⚠️ Limited performance for large data volumes

## 🐘 Using PostgreSQL

To use PostgreSQL, you have two options:

### Option 1: Use docker-compose.postgres.yml (Recommended)

There is already a `docker-compose.postgres.yml` file ready to use:

Configure in `.env`:
```bash
POSTGRES_USER=mesh_user
POSTGRES_PASSWORD=secure_password_here
POSTGRES_DB=mesh_db
```

```bash
# Start with PostgreSQL included
docker compose -f docker-compose.postgres.yml up -d
```

The `DATABASE_URL` will be configured automatically, but you can specify it if needed.

```bash
DATABASE_URL=postgresql://mesh_user:secure_password_here@localhost:5432/mesh_db
```

### Option 2: External PostgreSQL

If you already have a PostgreSQL running (local or remote):

```bash
# .env
DATABASE_URL=postgresql://user:password@host:5432/database_name
```

**Example with local PostgreSQL:**
```bash
DATABASE_URL=postgresql://postgres:password@localhost:5432/mesh_db
```

**Example with remote PostgreSQL:**
```bash
DATABASE_URL=postgresql://user:password@db.example.com:5432/mesh_db
```

**PostgreSQL Advantages:**
- ✅ Supports multiple instances (horizontal scalability)
- ✅ Better performance for large volumes
- ✅ Advanced features (backups, replication, etc.)

## 🔐 Authentication Configuration (auth-config.json)

### 📍 Location in Container

The `auth-config.json` file is mounted at the path:

```
/app/apps/mesh/auth-config.json
```

### 🔄 How it Works in Docker Compose

#### 1. Local File

The `auth-config.json` file must exist in the root folder, alongside docker-compose to start the stack:

```yaml
volumes:
  - ./auth-config.json:/app/apps/mesh/auth-config.json:ro
```

#### 2. Mount in Container

- **Source**: `./auth-config.json` (file in root, alongside docker-compose)
- **Destination**: `/app/apps/mesh/auth-config.json` (inside container)
- **Mode**: `ro` (read-only)

#### 3. When it's Loaded

The Mesh application loads this file on startup to configure:

- Email/Password authentication
- Social providers (Google, GitHub)
- SAML providers
- Email providers (Resend, etc.)
- Magic link configuration

### 📝 File Structure

The `auth-config.json` file can have different levels of complexity depending on the features you want to enable.

#### Available Example Files

There are two example files in the `conf-examples/` folder:

##### 1. `auth-config.json.example` - Simple Configuration

Use this file when you only need basic email and password authentication:

```json
{
  "emailAndPassword": {
    "enabled": true
  }
}
```

**When to use:**
- Only email/password authentication
- Don't need SSO or social login
- Don't need to send emails (invites, magic links, etc.)

##### 2. `auth-config-sso-email.json.example` - Complete Configuration

Use this file when you need advanced features like SSO, social login and email sending:

```json
{
  "emailAndPassword": {
    "enabled": true
  },
  "socialProviders": {
    "google": {
      "clientId": "",
      "clientSecret": ""
    },
    "github": {
      "clientId": "",
      "clientSecret": ""
    }
  },
  "saml": {
    "enabled": false,
    "providers": []
  },
  "emailProviders": [
    {
      "id": "resend-primary",
      "provider": "resend",
      "config": {
        "apiKey": "",
        "fromEmail": "noreply@example.com"
      }
    }
  ],
  "inviteEmailProviderId": "resend-primary",
  "magicLinkConfig": {
    "enabled": true,
    "emailProviderId": "resend-primary"
  }
}
```

**When to use:**
- Need SSO (SAML)
- Need social login (Google, GitHub)
- Need to send emails (invites, magic links, etc.)
- Need magic links for passwordless authentication

#### Complete Reference Structure

The complete structure of the `auth-config.json` file includes:

- **emailAndPassword**: Basic email/password authentication
- **socialProviders**: Social providers (Google, GitHub)
- **saml**: SAML configuration for enterprise SSO
- **emailProviders**: Email provider configuration (Resend, etc.)
- **inviteEmailProviderId**: Email provider ID for sending invites
- **magicLinkConfig**: Magic link configuration (authentication via link sent by email)

### 🛠️ How to Edit

1. **Edit the file locally**:

```bash
# Open your file editor with the file and make edits
vim auth-config.json
```

2. **Restart the container** to load the changes:

```bash
docker compose restart mesh
```

3. **Or recreate the container**:

```bash
docker compose up -d --force-recreate mesh
```

### ⚠️ Important

- The file must be valid JSON
- If the file doesn't exist, Docker Compose will fail to start
- Choose the example file appropriate to your needs:
  - **Simple configuration**: Use `conf-examples/auth-config.json.example`
  - **SSO and email sending**: Use `conf-examples/auth-config-sso-email.json.example`
- Don't commit secrets (clientSecret, apiKey) in the file in production

## 🔐 Security

### Generate BETTER_AUTH_SECRET

**⚠️ IMPORTANT**: Always generate a secure secret in production:

```bash
# Generate secure secret (32+ characters)
openssl rand -base64 32

# Add to .env
BETTER_AUTH_SECRET=your_generated_secret_here
```

### Protect .env file

```bash
# Don't commit .env to Git
echo ".env" >> .gitignore

# Set restrictive permissions
chmod 600 .env
```

## 📊 Monitoring

### Logs

```bash
# View logs in real time
docker compose logs -f mesh

# View last 100 lines
docker compose logs --tail=100 mesh

# View logs since a timestamp
docker compose logs --since 2024-01-01T00:00:00 mesh
```

### Container Status

```bash
# View status
docker compose ps

# View details
docker compose ps -a

# View resource usage
docker stats deco-mcp-mesh
```

### Reset Volume (Delete Data)

To completely reset data and start from scratch:

#### Method 1: Use Docker Compose (Recommended) ✅

```bash
# Stop containers and remove volumes
docker compose down -v

# Restart with empty volume
docker compose up -d
```

The `-v` flag removes the named volumes defined in `docker-compose.yml`.

#### Method 2: Reset specific volume

```bash
# Stop only the service
docker compose stop mesh

# Remove specific volume
docker volume rm docker_mesh-data

# Or if in another directory:
docker volume rm helm-chart-deco-mcp-mesh_mesh-data

# Restart (will create new empty volume)
docker compose up -d
```

#### Method 3: Backup before resetting

```bash
# 1. Backup first
docker compose cp mesh:/app/data/mesh.pglite ./backup-$(date +%Y%m%d-%H%M%S).pglite

# 2. Reset
docker compose down -v
docker compose up -d
```

#### Method 4: Reset only PGlite (keep other data)

If you want to reset only the PGlite database keeping other files:

```bash
# Enter container
docker compose exec mesh sh

# Inside container, remove only the database
rm -rf /app/data/mesh.pglite

# Restart application (will recreate database)
exit
docker compose restart mesh
```

#### Verify volumes

```bash
# List volumes
docker volume ls | grep mesh

# View volume details
docker volume inspect docker_mesh-data

# View used size
docker system df -v
```

**⚠️ Warning**: 
- `docker compose down -v` **permanently deletes all data**
- Make a backup first if you have important data
- Volumes are not automatically removed when you run `docker compose down` (without `-v`)

## 🔄 Updating

### Update Image

```bash
# Stop application
docker compose down

# Update image
docker compose pull

# Restart
docker compose up -d
```

### Update to specific version

```bash
# Edit .env
IMAGE_TAG=0.1.24

# Update
docker compose pull
docker compose up -d
```

## 📦 Backup and Restore

### Backup (PGlite)

```bash
# Copy to host
docker compose cp mesh:/app/data/mesh.pglite ./backup-$(date +%Y%m%d).pglite
```

### Backup (PostgreSQL)

```bash
# Database backup
docker compose exec postgres pg_dump -U mesh_user mesh_db > backup-$(date +%Y%m%d).sql

# Restore
docker compose exec -T postgres psql -U mesh_user mesh_db < backup-20240101.sql
```
