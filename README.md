# Book Distiller

Book Distiller is a web application that generates in-depth, multi-section
analyses of books using large language models. Upload a PDF or EPUB and the app
walks you through a section-by-section distillation that you can edit, accept,
or discard.

## Core Features

- **Multi-provider LLM support** – switch between OpenAI, Anthropic, and Google
  models.
- **Section workflow** – press **Start** to create the first section, then
  **Next** to request another. Each section can be edited inline, accepted, or
  discarded.
- **Auto‑advance mode** – when enabled, accepting a section automatically
  triggers generation of the next one until a stop token appears or the
  configured section limit is reached.
- **Undo & stop controls** – undo the last accepted section or stop generation
  mid‑process.
- **Export options** – download the stitched sections as Markdown or plain text.

## Getting Started

```bash
pnpm i
pnpm dev
```

The development server runs at `http://localhost:3000`.

## Deployment

- Build command: `pnpm build`
- Output directory: `dist`

### Vercel

- https://vercel.com/docs/frameworks/vite

### Netlify

- https://docs.netlify.com/frameworks/vite/

## References

- [Vite](https://vitejs.dev)
- [TailwindCSS](https://tailwindcss.com/)
- [TypeScript](https://www.typescriptlang.org)

