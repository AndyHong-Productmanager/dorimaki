# [![Purinton Dev](https://purinton.us/logos/brand.png)](https://discord.gg/QSBxQnX7PF)

## @purinton/errors [![npm version](https://img.shields.io/npm/v/@purinton/errors.svg)](https://www.npmjs.com/package/@purinton/errors)[![license](https://img.shields.io/github/license/purinton/errors.svg)](LICENSE)[![build status](https://github.com/purinton/errors/actions/workflows/nodejs.yml/badge.svg)](https://github.com/purinton/errors/actions)

> Minimal Node.js process-level error handler utility for uncaught exceptions, unhandled rejections, and warnings. Works in both CommonJS and ESM environments.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Usage](#usage)
  - [ESM Example](#esm-example)
  - [CommonJS Example](#commonjs-example)
- [API](#api)
- [TypeScript](#typescript)
- [Support](#support)
- [License](#license)
- [Links](#links)

## Features

- Handles uncaught exceptions, unhandled rejections, and warnings
- Pluggable logger (defaults to [@purinton/log](https://www.npmjs.com/package/@purinton/log))
- Easy to add/remove handlers for testability
- Works in both CommonJS and ESM modules

## Installation

```bash
npm install @purinton/errors
```

## Usage

### ESM Example

```js
import { registerHandlers } from '@purinton/errors';
registerHandlers();

// Or with options:
// registerHandlers({ processObj: process, log: customLogger });

// Simulate an uncaught exception
setTimeout(() => { throw new Error('Demo uncaught exception'); }, 1000);
```

### CommonJS Example

```js
const { registerHandlers } = require('@purinton/errors');
registerHandlers();

// Or with options:
// registerHandlers({ processObj: process, log: customLogger });

// Simulate an uncaught exception
setTimeout(() => { throw new Error('Demo uncaught exception'); }, 1000);
```

## API

### registerHandlers(options)

Registers process-level exception handlers. Returns an object with a `removeHandlers` function to detach all handlers (useful for testing).

- `options` (optional): An object with the following properties:
  - `processObj` (optional): The process object to attach handlers to (default: `process`)
  - `log` (optional): Logger for output (default: [@purinton/log](https://www.npmjs.com/package/@purinton/log))
- **Returns:** `{ removeHandlers: () => void }`

## TypeScript

Type definitions are included:

```ts
export declare function registerHandlers(
  options?: {
    processObj?: NodeJS.Process,
    log?: typeof import('@purinton/log')
  }
): { removeHandlers: () => void };
```

## Support

For help, questions, or to chat with the author and community, visit:

[![Discord](https://purinton.us/logos/discord_96.png)](https://discord.gg/QSBxQnX7PF)[![Purinton Dev](https://purinton.us/logos/purinton_96.png)](https://discord.gg/QSBxQnX7PF)

**[Purinton Dev on Discord](https://discord.gg/QSBxQnX7PF)**

## License

[MIT © 2025 Russell Purinton](LICENSE)

## Links

- [GitHub](https://github.com/purinton/errors)
- [npm](https://www.npmjs.com/package/@purinton/errors)
- [Discord](https://discord.gg/QSBxQnX7PF)
