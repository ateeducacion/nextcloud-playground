# Nextcloud Playground

Nextcloud Playground runs a full [Nextcloud](https://nextcloud.com) server
entirely in the browser using WebAssembly. There is no backend: PHP, the
Nextcloud application, and its SQLite database all execute inside your browser
tab on the [`@php-wasm`](https://github.com/WordPress/wordpress-playground)
runtime — the same PHP-in-WebAssembly engine that powers WordPress Playground.

It is a sibling of the Moodle, Omeka S, and FacturaScripts playgrounds, sharing
the same shell → service worker → PHP worker → `@php-wasm` architecture.

> **Status:** the Phase-0 feasibility spike proved that Nextcloud **31.0.14**
> installs against SQLite and serves its login page under php-wasm (PHP 8.3)
> with a small set of source patches and a posix polyfill. See
> [feasibility-spike.md](feasibility-spike.md) for the proven approach and
> constraints. The remaining hard problem is bundle size / browser memory.

## Try it

- **Online:** open the hosted GitHub Pages build (the live demo link in the
  repository).
- **Locally:** `make up`, then open <http://localhost:8085/>.

Default credentials are **`admin` / `admin`**. After boot you land on the login
page (`/index.php/login`) or, with autologin enabled, directly on the dashboard.

## Use this documentation to

- [Get started](getting-started.md) — try it online or run it locally.
- [Understand the architecture and build](development.md) — shell, runtime, the
  ZIP bundle, the occ install, and how to add a Nextcloud version.
- [Write a blueprint](blueprint-json.md) — the declarative JSON that provisions
  users, groups, apps, config, files and shares via `occ`.
- [Know the limits](KNOWN-ISSUES.md) — features that are dead or degraded under
  WebAssembly.
- [Read the feasibility spike](feasibility-spike.md) — the single most important
  reference: the proven patch set and constraints.

## How it works (one paragraph)

The shell page hosts an iframe whose requests are intercepted by a service
worker and routed to a PHP worker. The worker boots a `@php-wasm` PHP 8.3
runtime, extracts a **trimmed, readonly Nextcloud core bundle** into the
in-memory filesystem (MEMFS), installs Nextcloud against **SQLite** via `occ
maintenance:install`, applies a blueprint, and serves the web UI back into the
iframe. A **posix polyfill** plus a **five-patch source set** (all gated on
`PHP_SAPI === 'wasm'`) make Nextcloud's PHP run in this sandbox. Mutable state
lives in browser persistence and is ephemeral by default.

## Supported versions

Nextcloud majors **30**, **31** (default), and **32**, all built against
php-wasm PHP **8.3**. See `src/shared/nextcloud-versions.js`.

## Useful links

- Nextcloud: <https://nextcloud.com/>
- Nextcloud server source: <https://github.com/nextcloud/server>
- WordPress Playground (architecture / `@php-wasm`):
  <https://wordpress.github.io/wordpress-playground/>
