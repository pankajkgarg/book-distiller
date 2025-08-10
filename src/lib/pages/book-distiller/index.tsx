import Dexie, { type Table } from 'dexie';
import JSZip from 'jszip';
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist';
// @ts-ignore - Vite will provide a Worker constructor
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';

// @ts-ignore
pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

const DEFAULT_STOP_TOKEN = '<end_of_book>';

const DEFAULT_PROMPT = `Your Mission:
Your mission is to act as an immersive guide to a book I provide. You will embody the author/narrator's voice and generate a series of modular, in-depth sections exploring the book's core themes. The final goal is for me to be able to combine all of your responses into a single, cohesive, and seamlessly flowing document that feels like a standalone analysis written by the author.
You are not a summarizer; you are a deep-dive analyst and storyteller. Depth, detail, and the generous use of memorable excerpts are far more important than conciseness.

Our Interaction Protocol:
* To begin, I will provide you with the book content. 
* You will generate the first section based on the book's most foundational theme.
* For every subsequent part, I will simply reply with the word: "Next".
* When you receive "Next", you must autonomously determine the next logical theme based on the book's narrative arc. You will then generate the next complete section according to the structure above, ensuring your introductory paragraph creates a perfect transition from the section you just wrote.
* IMPORTANT! When all sections have been generated, only output "<end_of_book>" as your response to signal that whole book has been processed.   `;

class BDDatabase extends Dexie {
  books!: Table<{
    id: string;
    name: string;
    blob?: Blob;
    text?: string;
    title?: string;
    author?: string;
    createdAt: number;
  }>;
  sections!: Table<{
    id: string;
    bookId: string;
    content: string;
    heading: string;
    status: 'draft' | 'accepted' | 'discarded';
    order: number;
  }>;
  settings!: Table<{ key: string; value: any }>;

  constructor() {
    super('book_distiller_db');
    this.version(1).stores({
      books: 'id, createdAt',
      sections: 'id, bookId, order',
      settings: 'key',
    });
  }
}

const db = new BDDatabase();

function inferMetadataFromFilename(name = '') {
  const base = name
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  const by = base.split(/\s+by\s+/i);
  if (by.length === 2) return { title: by[0].trim(), author: by[1].trim() };
  const parts = base.split(' - ');
  if (parts.length === 2)
    return { title: parts[0].trim(), author: parts[1].trim() };
  return { title: base, author: '' };
}

function parseHeading(md: string) {
  const m = md.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return (
    (md.split('\n')[0] || '').replace(/^#+\s*/, '').slice(0, 120) || 'Untitled'
  );
}

async function ensurePersistence() {
  if ((navigator as any).storage && (navigator as any).storage.persist) {
    try {
      await (navigator as any).storage.persist();
    } catch {}
  }
}

async function extractTextFromEPUB(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  const containerXml = await zip
    .file('META-INF/container.xml')
    ?.async('string');
  if (!containerXml) throw new Error('EPUB: container.xml not found');
  const cdoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfile = cdoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new Error('EPUB: rootfile not found');

  const opfText = await zip.file(rootfile)?.async('string');
  if (!opfText) throw new Error('EPUB: OPF not found');
  const opf = new DOMParser().parseFromString(opfText, 'application/xml');
  const manifest = new Map<string, string>();
  opf.querySelectorAll('manifest > item').forEach((it) => {
    const id = it.getAttribute('id') || '';
    const href = it.getAttribute('href') || '';
    manifest.set(id, href);
  });
  const spineIds: string[] = [];
  opf.querySelectorAll('spine > itemref').forEach((ir) => {
    const idref = ir.getAttribute('idref') || '';
    if (idref) spineIds.push(idref);
  });

  const basePath = rootfile.split('/').slice(0, -1).join('/');
  let out = '';
  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;
    const full = basePath ? `${basePath}/${href}` : href;
    const html = await zip.file(full)?.async('string');
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = (doc.body?.textContent || '')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    out += text + '\n\n';
  }
  return out.trim();
}

async function extractTextFromPDF(file: File): Promise<string> {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((it: any) => it.str).join(' ');
    text += pageText + '\n\n';
  }
  return text.trim();
}

async function callOpenAI({
  apiKey,
  model,
  system,
  user,
}: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callAnthropic({
  apiKey,
  model,
  system,
  user,
}: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic error ${res.status}`);
  const data = await res.json();
  return (data.content || []).map((p: any) => p.text).join('\n');
}

async function callGemini({
  apiKey,
  model,
  system,
  user,
}: {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: system + '\n\n' + user }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts.map((p: any) => p.text).join('\n');
}

export default function BookDistiller() {
  const [bookId, setBookId] = useState<string>('');
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [bookText, setBookText] = useState('');

  const [prompt, setPrompt] = useState(
    () => localStorage.getItem('bd_prompt') || DEFAULT_PROMPT,
  );

  const [provider, setProvider] = useState(
    () => localStorage.getItem('bd_provider') || 'openai',
  );
  const [model, setModel] = useState(
    () => localStorage.getItem('bd_model') || 'gpt-4o-mini',
  );

  // Initialize API keys per provider
  const getApiKeys = () => {
    try {
      const stored = localStorage.getItem('bd_apiKeys');
      if (stored) {
        return JSON.parse(stored);
      }

      // Migration: if old single API key exists, migrate it to the new structure
      const oldApiKey = localStorage.getItem('bd_apiKey');
      if (oldApiKey) {
        const migrated = { openai: oldApiKey }; // Default to openai for old keys
        localStorage.removeItem('bd_apiKey'); // Clean up old key
        return migrated;
      }

      return {};
    } catch {
      return {};
    }
  };

  const [apiKeys, setApiKeys] = useState<Record<string, string>>(getApiKeys);
  const currentApiKey = apiKeys[provider] || '';

  const setCurrentApiKey = (key: string) => {
    const newKeys = { ...apiKeys, [provider]: key };
    setApiKeys(newKeys);
  };

  useEffect(() => {
    localStorage.setItem('bd_apiKeys', JSON.stringify(apiKeys));
  }, [apiKeys]);
  useEffect(() => {
    localStorage.setItem('bd_provider', provider);
  }, [provider]);
  useEffect(() => {
    localStorage.setItem('bd_model', model);
  }, [model]);
  useEffect(() => {
    localStorage.setItem('bd_prompt', prompt);
  }, [prompt]);

  const [autoAdvance, setAutoAdvance] = useState(false);
  const [maxSections, setMaxSections] = useState(12);
  const [stopToken, setStopToken] = useState(DEFAULT_STOP_TOKEN);
  const [isBusy, setIsBusy] = useState(false);
  const [shouldStop, setShouldStop] = useState(false);

  const [sections, setSections] = useState<
    {
      id: string;
      content: string;
      heading: string;
      status: 'draft' | 'accepted' | 'discarded';
      order: number;
    }[]
  >([]);
  const accepted = useMemo(
    () =>
      sections
        .filter((s) => s.status === 'accepted')
        .sort((a, b) => a.order - b.order),
    [sections],
  );
  const stitched = useMemo(
    () => accepted.map((s) => s.content).join('\n\n'),
    [accepted],
  );

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (transcriptRef.current)
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [sections]);

  useEffect(() => {
    ensurePersistence();
  }, []);

  useEffect(() => {
    (async () => {
      const last = await db.settings.get('last_book_id');
      if (last?.value) {
        const b = await db.books.get(last.value);
        if (b) {
          setBookId(b.id);
          setTitle(b.title || '');
          setAuthor(b.author || '');
          setBookText(b.text || '');
          const secs = await db.sections
            .where({ bookId: b.id })
            .sortBy('order');
          setSections(secs);
        }
      }
    })();
  }, []);

  async function onUpload(f: File | null) {
    if (!f) return;
    const id = crypto.randomUUID();
    const meta = inferMetadataFromFilename(f.name);

    await db.books.put({
      id,
      name: f.name,
      blob: f,
      createdAt: Date.now(),
      title: meta.title,
      author: meta.author,
    });
    await db.settings.put({ key: 'last_book_id', value: id });
    setBookId(id);
    setTitle(meta.title);
    setAuthor(meta.author);

    try {
      let text = '';
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      if (ext === 'pdf') text = await extractTextFromPDF(f);
      else if (ext === 'epub') text = await extractTextFromEPUB(f);
      else if (['txt', 'md', 'markdown'].includes(ext)) text = await f.text();
      else throw new Error('Unsupported file type (use PDF/EPUB/TXT/MD)');

      setBookText(text);
      await db.books.update(id, { text });
    } catch (e: any) {
      alert(e?.message || String(e));
    }
  }

  function clearRun() {
    if (!bookId) return;
    setSections([]);
    db.sections.where({ bookId }).delete();
  }

  function undoLast() {
    if (!bookId) return;
    setSections((prev) => {
      const i = [...prev].reverse().findIndex((s) => s.status === 'accepted');
      if (i === -1) return prev;
      const idx = prev.length - 1 - i;
      const copy = [...prev];
      const popped = copy.splice(idx, 1)[0];
      db.sections.delete(popped.id);
      return copy;
    });
  }

  function updateSectionLocal(upd: {
    id: string;
    content?: string;
    heading?: string;
    status?: 'draft' | 'accepted' | 'discarded';
  }) {
    setSections((prev) =>
      prev.map((s) =>
        s.id === upd.id
          ? {
              ...s,
              ...upd,
              heading: upd.heading ?? parseHeading(upd.content ?? s.content),
            }
          : s,
      ),
    );
    db.sections.update(upd.id, upd);
  }

  async function generateNext(acceptedOverride?: typeof accepted) {
    if (!bookId) {
      alert('Upload a book first');
      return;
    }
    if (!currentApiKey) {
      alert('Paste your API key (stored locally)');
      return;
    }
    if (shouldStop) {
      console.info('Generation stopped by user');
      setShouldStop(false);
      return;
    }
    setIsBusy(true);
    try {
      const history = (acceptedOverride ?? accepted)
        .map((s) => s.content)
        .join('\n\n');
      const system = prompt;
      const user = `Book Title: ${title || '(unknown)'}\nAuthor: ${author || '(unknown)'}\n\nFull book text (or extract):\n${bookText.slice(0, 100000)}\n\nPreviously accepted sections (for continuity):\n${history}\n\nGenerate the next section according to the protocol above. Then end if appropriate with the stop token: ${stopToken}`;

      let text = '';
      if (provider === 'openai')
        text = await callOpenAI({ apiKey: currentApiKey, model, system, user });
      else if (provider === 'anthropic')
        text = await callAnthropic({
          apiKey: currentApiKey,
          model,
          system,
          user,
        });
      else if (provider === 'google')
        text = await callGemini({ apiKey: currentApiKey, model, system, user });
      else throw new Error('Unsupported provider');

      const id = crypto.randomUUID();
      const order = sections.length + 1;
      const isFirstSection = sections.length === 0;
      
      // Auto-accept sections when auto-advance is enabled and it's not the first section
      const sectionStatus = (autoAdvance && !isFirstSection) ? 'accepted' as const : 'draft' as const;
      
      const section = {
        id,
        bookId,
        content: text.trim(),
        heading: parseHeading(text),
        status: sectionStatus,
        order,
      };
      setSections((prev) => [...prev, section]);
      await db.sections.put(section);

      // If auto-advance is enabled and this is not the first section, continue generating
      if (autoAdvance && !isFirstSection && !shouldStop) {
        // Check if we should continue (no stop token and under max sections)
        const hasStopToken = text.trim().includes(stopToken);
        
        // Get current accepted count from database (more reliable than state)
        setTimeout(async () => {
          if (shouldStop) return;
          
          const currentSections = await db.sections
            .where({ bookId })
            .sortBy('order');
          const acceptedCount = currentSections.filter(s => s.status === 'accepted').length;
          
          console.info('Auto-advance check:', {
            hasStopToken,
            acceptedCount,
            maxSections,
            shouldContinue: !hasStopToken && acceptedCount < maxSections
          });
          
            if (!hasStopToken && acceptedCount < maxSections) {
              console.info('Auto-advancing to next section...');
              generateNext();
            } else {
              console.info('Auto-advance stopped:', {
                hasStopToken,
                reachedMax: acceptedCount >= maxSections
              });
              setAutoAdvance(false);
            }
          }, 500);
        }
    } catch (e: any) {
      alert(e?.message || String(e));
    } finally {
      setIsBusy(false);
      // Reset stop flag when generation completes or fails
      setShouldStop(false);
    }
  }

  async function accept(id: string) {
    updateSectionLocal({ id, status: 'accepted' });

    // Check if this acceptance should trigger auto-advance (for first section)
    if (autoAdvance && !isBusy && !shouldStop) {
      // Small delay to let state update
      setTimeout(async () => {
        // Check again in case stop was pressed during the delay
        if (shouldStop) {
          console.info('Auto-advance cancelled by user');
          return;
        }
        
        const currentSections = await db.sections
          .where({ bookId })
          .sortBy('order');
        const acceptedSections = currentSections
          .filter((s) => s.status === 'accepted')
          .sort((a, b) => a.order - b.order);
        const acceptedCount = acceptedSections.length;
        const lastSection = currentSections[currentSections.length - 1];

        console.info(
          `Auto-advance check: accepted=${acceptedCount}, max=${maxSections}, autoAdvance=${autoAdvance}`,
        );

        // Only auto-advance if we haven't reached max sections and the last section doesn't contain the stop token
        if (
          lastSection &&
          !lastSection.content.includes(stopToken) &&
          acceptedCount < maxSections
        ) {
          console.info('Auto-advancing to next section...');
          await generateNext(acceptedSections);
        } else {
          console.info('Auto-advance stopped:', {
            hasStopToken: lastSection?.content.includes(stopToken),
            reachedMax: acceptedCount >= maxSections,
          });
          setAutoAdvance(false);
        }
      }, 200);
    }
  }

  function discard(id: string) {
    updateSectionLocal({ id, status: 'discarded' });
  }
  function edit(id: string, content: string) {
    updateSectionLocal({ id, content });
  }

  function download(ext: 'md' | 'txt') {
    const blob = new Blob([stitched], {
      type: ext === 'md' ? 'text/markdown' : 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(title || 'distillation').toLowerCase().replace(/\s+/g, '-')}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const charCount = bookText.length;

  return (
    <div className="mx-auto max-w-7xl p-4 space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">Book Distiller</h1>
        <Badge variant="secondary" className="ml-2">
          Client‑only
        </Badge>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 lg:col-span-3 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Source</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Input
                type="file"
                accept=".pdf,.epub,.txt,.md,.markdown"
                onChange={(e) => onUpload(e.target.files?.[0] || null)}
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  placeholder="Title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <Input
                  placeholder="Author"
                  value={author}
                  onChange={(e) => setAuthor(e.target.value)}
                />
              </div>
              <div className="text-xs text-muted-foreground">
                {charCount
                  ? `${charCount.toLocaleString()} chars extracted`
                  : 'No text yet'}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                className="h-56"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Model</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger>
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google (Gemini)</SelectItem>
                </SelectContent>
              </Select>
              <Input
                placeholder="Model (e.g., gpt-4o-mini, claude-3-5-sonnet, gemini-1.5-pro)"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
              <Input
                type="password"
                placeholder={`API key for ${provider} (stored locally)`}
                value={currentApiKey}
                onChange={(e) => setCurrentApiKey(e.target.value)}
              />
              <div className="text-[11px] text-muted-foreground">
                Keys in the browser are visible to the page. Use
                temporary/restricted keys ideally.
              </div>
            </CardContent>
          </Card>

        </div>

        <div className="col-span-12 lg:col-span-5">
          <Card className="h-[72vh] flex flex-col overflow-hidden">
            <CardHeader className="flex-shrink-0">
              <CardTitle className="text-base">Transcript</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 min-h-0 p-0">
              <ScrollArea className="h-full" ref={transcriptRef}>
                <div className="space-y-3 p-6">
                  {sections.length === 0 && (
                    <div className="text-sm text-muted-foreground">
                      No sections yet. Click{' '}
                      <span className="font-medium">Start</span> to generate.
                    </div>
                  )}
                  {sections.map((s, idx) => (
                    <div key={s.id} className="border rounded-xl p-3 bg-white dark:bg-gray-950">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-sm font-semibold truncate pr-2">
                          {s.heading || `Section ${idx + 1}`}
                        </div>
                        <Badge
                          variant={
                            s.status === 'accepted'
                              ? 'default'
                              : s.status === 'discarded'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {s.status}
                        </Badge>
                      </div>
                      <Textarea
                        className="mt-2 h-40 resize-none overflow-auto"
                        value={s.content}
                        onChange={(e) => edit(s.id, e.target.value)}
                      />
                      {s.status === 'draft' && (
                        <div className="flex gap-2 mt-2">
                          <Button variant="default" className="border" onClick={() => accept(s.id)}>Accept</Button>
                          <Button variant="outline" onClick={() => discard(s.id)}>
                            Discard
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
            <CardFooter className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="default"
                  onClick={() => {
                    setAutoAdvance(false);
                    generateNext();
                  }}
                  disabled={isBusy}
                >
                  {isBusy
                    ? 'Generating...'
                    : sections.length
                      ? 'Next'
                      : 'Start'}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setAutoAdvance(true);
                    generateNext();
                  }}
                  disabled={isBusy}
                >
                  Auto advance
                </Button>
                <Input
                  className="w-20"
                  type="number"
                  value={maxSections}
                  onChange={(e) =>
                    setMaxSections(parseInt(e.target.value || '1'))
                  }
                />
              </div>
              <Input
                placeholder="Stop token"
                value={stopToken}
                onChange={(e) => setStopToken(e.target.value)}
              />
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={undoLast}>
                  Undo last
                </Button>
                {(isBusy || autoAdvance) && (
                  <Button
                    variant="destructive"
                    className="flex-1"
                    onClick={() => {
                      setShouldStop(true);
                      setAutoAdvance(false);
                    }}
                    disabled={!isBusy && !autoAdvance}
                  >
                    Stop Process
                  </Button>
                )}
                <Button variant="outline" className="flex-1" onClick={clearRun}>
                  Clear run
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Accepted: {accepted.length} • Total: {sections.length}
              </div>
            </CardFooter>
          </Card>
        </div>

        <div className="col-span-12 lg:col-span-4 space-y-4">
          <Card className="h-[48vh] flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">Outline</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              <ol className="space-y-1 text-sm">
                {accepted.length === 0 && (
                  <li className="text-muted-foreground">(empty)</li>
                )}
                {accepted.map((s, i) => (
                  <li key={s.id} className="flex items-center gap-2">
                    <span className="w-6 h-6 inline-flex items-center justify-center rounded-full bg-foreground text-background text-xs">
                      {i + 1}
                    </span>
                    <span className="truncate" title={s.heading}>
                      {s.heading}
                    </span>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          <Card className="h-[48vh] flex flex-col">
            <CardHeader>
              <CardTitle className="text-base">Draft (stitched)</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 overflow-auto">
              <div className="text-sm whitespace-pre-wrap leading-6 min-h-24">
                {stitched || (
                  <span className="text-muted-foreground">
                    Accepted sections will appear here…
                  </span>
                )}
              </div>
              <Separator className="my-2" />
              <div className="flex gap-2">
                <Button onClick={() => navigator.clipboard.writeText(stitched)}>
                  Copy all
                </Button>
                <Button variant="outline" onClick={() => download('md')}>
                  .md
                </Button>
                <Button variant="outline" onClick={() => download('txt')}>
                  .txt
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <footer className="text-xs text-muted-foreground">
        PDF/EPUB are parsed locally. Storage is persistent in your browser
        (IndexedDB).
      </footer>
    </div>
  );
}
