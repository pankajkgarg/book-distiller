# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Book Distiller** web application that allows users to upload PDF/EPUB files and generate in-depth, multi-section book analyses using various LLM providers (OpenAI, Anthropic, Google). The app provides a multi-turn conversation workflow where users can review, edit, and approve each generated section before combining them into a complete distillation.

**Tech Stack:**
- Vite + React 19 + TypeScript
- TanStack Router (file-based routing)
- TailwindCSS v4 + shadcn/ui components
- IndexedDB (via Dexie) for persistent local storage
- Client-side PDF/EPUB parsing (pdfjs-dist, JSZip)
- Biome for linting/formatting

## Essential Development Commands

```bash
# Development
pnpm dev              # Start dev server on port 3000
pnpm build            # Build for production
pnpm serve            # Preview production build

# Code Quality
pnpm type:check       # Run TypeScript checks
pnpm biome:check      # Run Biome linter/formatter
pnpm biome:fix        # Auto-fix Biome issues
pnpm test             # Run all tests
pnpm test:ui          # Run tests with coverage UI

# All quality checks at once
pnpm check:turbo      # Run biome:check, type:check, and test

# Installation
pnpm i               # Install dependencies (requires Node.js >=22.16.x)
```

## Architecture & Code Organization

### Core Application Structure

```
src/
├── lib/pages/book-distiller/     # Main BookDistiller component
├── routes/                       # TanStack Router file-based routes
├── components/ui/                # shadcn/ui components (auto-generated)
├── lib/layout/                   # Header, Footer, Layout wrapper
├── lib/components/               # Custom reusable components
└── lib/utils.ts                  # Utility functions (cn, etc.)
```

### Book Distiller Architecture

The main application logic is in `src/lib/pages/book-distiller/index.tsx` and implements:

1. **Storage Layer**: Dexie/IndexedDB database with tables for books, sections, settings
2. **File Processing**: Client-side PDF extraction (pdfjs-dist) and EPUB parsing (JSZip + DOMParser)
3. **Multi-Provider LLM Integration**: Direct API calls to OpenAI, Anthropic, Google with configurable models
4. **Multi-Turn Workflow**: Step-by-step section generation with review/approval system
5. **Export System**: Copy to clipboard or download as .md/.txt files

### Key Features Implementation

- **Persistent Storage**: All data (books, generated sections, API keys) stored locally in browser
- **Auto-advance Mode**: Configurable automatic section generation up to specified limits
- **Cross-provider Switching**: Users can change LLM providers mid-conversation
- **Real-time Editing**: Generated sections can be edited inline before acceptance

## Development Guidelines

### File Naming & Structure

- Use **kebab-case** for all files (enforced by Biome)
- Page components go in `src/lib/pages/{page-name}/index.tsx`
- Routes use TanStack Router conventions in `src/routes/`
- shadcn/ui components in `src/components/ui/` (don't edit manually)

### Code Quality Rules

- **No default exports** except for page components (`src/lib/pages/*/index.tsx`) and config files
- **Unused imports/variables** are errors (enforced by Biome)
- **Console statements** limited to `console.error()` and `console.info()`
- **Accessibility** rules enforced (semantic elements required)
- **Type safety** strictly enforced with verbatimModuleSyntax
- **File naming**: kebab-case enforced by Biome (except TanStack Router files)
- **Import organization**: Automatic grouping (Node/package imports, aliases, relative paths)

### Adding shadcn/ui Components

```bash
pnpm dlx shadcn@latest add [component-name]
```

Components are configured to use:
- **Style**: new-york
- **Base color**: neutral
- **Path aliases**: `@/components` and `@/lib/utils`

### Working with the Book Distiller

When modifying the BookDistiller component:

1. **Database Schema**: Changes to Dexie tables require version increments
2. **LLM Integration**: API calls are direct from browser (CORS must be handled by providers)
3. **File Processing**: Large files are handled via streaming and chunking
4. **State Management**: Uses React hooks with IndexedDB persistence
5. **Worker Integration**: PDF processing uses Vite's ?worker loader pattern

### Testing Notes

- Tests use Vitest with jsdom environment
- Testing Library React for component testing
- Run `pnpm test:ui` for interactive test debugging with coverage UI
- Coverage reports available via `pnpm test:coverage`

### PWA Configuration

PWA is currently **disabled** (`disable: true` in vite.config.ts). To enable:
1. Set `disable: false` in pwaOptions
2. Run `pnpm generate-pwa-assets` to generate icons
3. Update manifest.json with correct app details

## Important Implementation Details

### LLM Provider Integration

The app makes direct browser-to-API calls. API keys are stored in localStorage with warnings about browser visibility. For production use, consider:
- Temporary/restricted API keys
- Local proxy server for key management
- Rate limiting implementation

### File Processing Limits

- PDF: Uses pdf.js with local worker (no CDN dependency)
- EPUB: Full client-side parsing via JSZip and DOMParser
- Large files (>100MB) may cause memory issues in browser
- Text extraction is truncated at 100,000 characters for LLM input

### Performance Considerations

- IndexedDB operations are asynchronous and cached
- Large generated sections can impact browser performance
- Auto-advance mode should be used carefully to avoid API rate limits