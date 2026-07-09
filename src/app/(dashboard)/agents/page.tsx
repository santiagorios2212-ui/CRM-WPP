'use client';

import { useEffect, useState } from 'react';
import { Bot, CalendarDays, Sparkles, Settings2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiConfig } from '@/components/settings/ai-config';
import { CalendarConfig } from '@/components/settings/calendar-config';

const TABS = ['playground', 'setup', 'calendar'] as const;
type Tab = (typeof TABS)[number];

const isTab = (value: string | null): value is Tab =>
  !!value && (TABS as readonly string[]).includes(value);

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>('playground');
  const [decided, setDecided] = useState(false);

  // Land first-time users on Setup, returning users on the Playground —
  // unless `?tab=` says otherwise, which is how the Google OAuth callback
  // brings the admin back to the Calendar tab.
  //
  // Read from `window.location` rather than `useSearchParams`, which would
  // force this page behind a Suspense boundary for no benefit.
  useEffect(() => {
    let cancelled = false;
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (isTab(requested)) {
      setTab(requested);
      setDecided(true);
      return;
    }
    (async () => {
      try {
        const res = await fetch('/api/ai/config');
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setTab(data?.configured ? 'playground' : 'setup');
      } catch {
        if (!cancelled) setTab('setup');
      } finally {
        if (!cancelled) setDecided(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          AI Agents
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Your bring-your-own-key AI agent — set it up, then test it in the
        playground before it replies to customers in the inbox.
      </p>

      {decided && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          className="mt-6"
        >
          <TabsList>
            <TabsTrigger value="playground">
              <Sparkles className="mr-1.5 h-4 w-4" /> Playground
            </TabsTrigger>
            <TabsTrigger value="setup">
              <Settings2 className="mr-1.5 h-4 w-4" /> Setup
            </TabsTrigger>
            <TabsTrigger value="calendar">
              <CalendarDays className="mr-1.5 h-4 w-4" /> Calendar
            </TabsTrigger>
          </TabsList>

          <TabsContent value="playground" className="mt-4">
            <AiPlayground onGoToSetup={() => setTab('setup')} />
          </TabsContent>

          <TabsContent value="setup" className="mt-4">
            <AiConfig />
          </TabsContent>

          <TabsContent value="calendar" className="mt-4">
            <CalendarConfig />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
