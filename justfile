# Usage FYI workspace tasks

# Default recipe - show available recipes
default:
    @just --list

# Run verification across all workspaces
verify:
    npm run verify --workspaces --if-present

# Build all workspaces
build:
    npm run build --workspaces --if-present

# Run tests across all workspaces
test:
    npm run test --workspaces --if-present

# Run typecheck across all workspaces
typecheck:
    npm run typecheck --workspaces --if-present

# Run lint across all workspaces
lint:
    npm run lint --workspaces --if-present
