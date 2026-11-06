# Archived files

These files are retained for reference and are not used by the current two-port frontend and REST API.

- `database/`: old SQL schemas and migration statements
- `legacy/php/`: previous PHP implementation
- `ejs/`: previous root-level Express/EJS application, its page routes, templates, and EJS-dependent tests
- `mysql-import/`: optional MySQL-to-MongoDB import utility
- `backups/`: ZIP backup formerly kept at the project root

The current app still uses the root `src/` MongoDB services and `assets/app.css`; those files were intentionally left in place. To restore an archived app component, move its files back to their original locations and restore its dependencies and package scripts as documented in the root project history.
