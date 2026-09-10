# Justfile for usage-fyi workspace
# Delegates to npm workspace scripts

default:
    @just --list

# Run verification (typecheck, lint, test) across all workspaces
verify:
    npm run verify

# Build all packages
build:
    npm run build

# Run tests across all workspaces
test:
    npm run test

# Run type checks across all workspaces
typecheck:
    npm run typecheck

# Run linting across all workspaces
lint:
    npm run lint
