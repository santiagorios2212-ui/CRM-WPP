'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  CalendarDays,
  CheckCircle2,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { DEFAULT_WORKING_HOURS, type WorkingHours } from '@/lib/calendar/types';

const DAYS: { key: string; label: string }[] = [
  { key: '1', label: 'Monday' },
  { key: '2', label: 'Tuesday' },
  { key: '3', label: 'Wednesday' },
  { key: '4', label: 'Thursday' },
  { key: '5', label: 'Friday' },
  { key: '6', label: 'Saturday' },
  { key: '0', label: 'Sunday' },
];

interface CalendarSettings {
  connected_email: string | null;
  timezone: string;
  slot_minutes: number;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_days_ahead: number;
  offer_slots: number;
  working_hours: WorkingHours;
  booking_enabled: boolean;
  confirmation_template: string;
}

const DEFAULTS: CalendarSettings = {
  connected_email: null,
  timezone: 'UTC',
  slot_minutes: 30,
  buffer_minutes: 15,
  min_notice_minutes: 120,
  max_days_ahead: 14,
  offer_slots: 3,
  working_hours: DEFAULT_WORKING_HOURS,
  booking_enabled: false,
  confirmation_template:
    'Listo, agendé la llamada para el {datetime}. Te envié la invitación a {email}.',
};

/** Google's own words, translated. Anything we do not recognise is shown
 *  verbatim — an unmapped code is more useful than "Something went wrong". */
const OAUTH_ERRORS: Record<string, string> = {
  access_denied: 'You cancelled the Google consent screen.',
  invalid_state: 'That connection attempt expired. Please try again.',
  forbidden: 'Only admins can connect a calendar.',
  missing_code: 'Google did not return an authorization code.',
  exchange_failed:
    'Google refused the authorization code. If you have connected before, remove the app at myaccount.google.com/permissions and retry.',
  storage_failed: 'The calendar connected, but the token could not be stored.',
};

const NUMBERS: { key: keyof CalendarSettings; label: string; hint: string }[] = [
  { key: 'slot_minutes', label: 'Meeting length (min)', hint: 'How long each booked call is.' },
  { key: 'buffer_minutes', label: 'Buffer (min)', hint: 'Kept free either side of every meeting.' },
  { key: 'min_notice_minutes', label: 'Minimum notice (min)', hint: 'How soon a call may be booked.' },
  { key: 'max_days_ahead', label: 'Days ahead', hint: 'How far out the agent will look.' },
  { key: 'offer_slots', label: 'Slots offered', hint: 'How many times to suggest at once.' },
];

export function CalendarConfig() {
  const { accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [settings, setSettings] = useState<CalendarSettings>(DEFAULTS);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/calendar');
      const data = await res.json().catch(() => ({}));
      setConnected(!!data.connected);
      setOauthConfigured(!!data.oauth_configured);
      if (data.config) setSettings({ ...DEFAULTS, ...data.config });
    } catch {
      toast.error('Could not load the calendar settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback bounces back here with a result in the query
  // string. Read it once, tell the user, then scrub it from the URL so a
  // refresh does not replay the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('calendar');
    const error = params.get('calendar_error');
    if (!ok && !error) return;

    if (ok === 'connected') toast.success('Google Calendar connected.');
    if (error) toast.error(OAUTH_ERRORS[error] ?? `Google returned: ${error}`);

    params.delete('calendar');
    params.delete('calendar_error');
    const query = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, []);

  const patch = <K extends keyof CalendarSettings>(key: K, value: CalendarSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const setRange = (day: string, index: number, which: 0 | 1, value: string) =>
    setSettings((s) => {
      const ranges = (s.working_hours[day] ?? []).map((r, i) =>
        i === index ? ((which === 0 ? [value, r[1]] : [r[0], value]) as [string, string]) : r,
      );
      return { ...s, working_hours: { ...s.working_hours, [day]: ranges } };
    });

  const addRange = (day: string) =>
    setSettings((s) => ({
      ...s,
      working_hours: {
        ...s.working_hours,
        [day]: [...(s.working_hours[day] ?? []), ['09:00', '17:00'] as [string, string]],
      },
    }));

  const removeRange = (day: string, index: number) =>
    setSettings((s) => {
      const ranges = (s.working_hours[day] ?? []).filter((_, i) => i !== index);
      const next = { ...s.working_hours };
      // An empty array and an absent key both mean "closed"; drop the key
      // so what we send matches what the engine reads.
      if (ranges.length === 0) delete next[day];
      else next[day] = ranges;
      return { ...s, working_hours: next };
    });

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/calendar', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save.');
      toast.success('Calendar settings saved.');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function disconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/calendar', { method: 'DELETE' });
      if (!res.ok) throw new Error('Could not disconnect.');
      toast.success('Calendar disconnected. Existing meetings were not cancelled.');
      setConnected(false);
      setSettings(DEFAULTS);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect.');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CalendarDays className="size-5 text-primary" />
            Google Calendar
          </CardTitle>
          <CardDescription>
            Let the agent offer your real free slots on WhatsApp and book the
            call the customer picks. It reads free/busy and creates the event —
            it never sees what your meetings are about.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!oauthConfigured && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">Google OAuth is not configured on this server.</p>
                <p className="text-muted-foreground">
                  Set <code>GOOGLE_OAUTH_CLIENT_ID</code> and{' '}
                  <code>GOOGLE_OAUTH_CLIENT_SECRET</code> in the environment, then reload.
                </p>
              </div>
            </div>
          )}

          {connected ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-emerald-600" />
                <span>
                  Connected
                  {settings.connected_email ? (
                    <span className="text-muted-foreground"> as {settings.connected_email}</span>
                  ) : null}
                </span>
              </div>
              {canEdit && (
                <Button variant="outline" size="sm" onClick={disconnect} disabled={disconnecting}>
                  {disconnecting ? (
                    <Loader2 className="mr-1.5 size-4 animate-spin" />
                  ) : (
                    <Trash2 className="mr-1.5 size-4" />
                  )}
                  Disconnect
                </Button>
              )}
            </div>
          ) : (
            <Button
              disabled={!canEdit || !oauthConfigured}
              // A full-page navigation, not fetch(): the browser has to
              // follow Google's redirect and carry the state cookie back.
              onClick={() => {
                window.location.href = '/api/calendar/google/connect';
              }}
            >
              Connect Google Calendar
            </Button>
          )}
        </CardContent>
      </Card>

      {connected && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Booking</CardTitle>
              <CardDescription>
                Off until you turn it on. Connecting lets the agent read your
                calendar; this is what lets it write to it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="booking-enabled">Let the agent book meetings</Label>
                  <p className="text-sm text-muted-foreground">
                    When off, the agent hands scheduling requests to a human.
                  </p>
                </div>
                <Switch
                  id="booking-enabled"
                  checked={settings.booking_enabled}
                  onCheckedChange={(v) => patch('booking_enabled', v)}
                  disabled={!canEdit}
                />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="timezone">Timezone</Label>
                  <Input
                    id="timezone"
                    value={settings.timezone}
                    onChange={(e) => patch('timezone', e.target.value)}
                    placeholder="America/Argentina/Buenos_Aires"
                    disabled={!canEdit}
                  />
                  <p className="text-xs text-muted-foreground">
                    IANA name. Working hours below are wall-clock times in this zone.
                  </p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {NUMBERS.map(({ key, label, hint }) => (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={key}>{label}</Label>
                    <Input
                      id={key}
                      type="number"
                      value={settings[key] as number}
                      onChange={(e) => patch(key, Number(e.target.value) as never)}
                      disabled={!canEdit}
                    />
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                ))}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="confirmation">Confirmation message</Label>
                <Input
                  id="confirmation"
                  value={settings.confirmation_template}
                  onChange={(e) => patch('confirmation_template', e.target.value)}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Sent once the event exists. Written by the CRM, not by the model.
                  Use <code>{'{datetime}'}</code> (required) and <code>{'{email}'}</code>.
                </p>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Working hours</CardTitle>
              <CardDescription>
                The agent only offers slots inside these ranges. Add a second
                range to a day for a split shift; remove them all to close it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {DAYS.map(({ key, label }) => {
                const ranges = settings.working_hours[key] ?? [];
                return (
                  <div
                    key={key}
                    className="flex flex-wrap items-start gap-3 border-b border-border pb-3 last:border-0 last:pb-0"
                  >
                    <span className="w-24 pt-2 text-sm font-medium">{label}</span>
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      {ranges.length === 0 && (
                        <span className="py-2 text-sm text-muted-foreground">Closed</span>
                      )}
                      {ranges.map((range, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <Input
                            type="time"
                            className="w-32"
                            value={range[0]}
                            onChange={(e) => setRange(key, i, 0, e.target.value)}
                            disabled={!canEdit}
                          />
                          <span className="text-muted-foreground">–</span>
                          <Input
                            type="time"
                            className="w-32"
                            value={range[1]}
                            onChange={(e) => setRange(key, i, 1, e.target.value)}
                            disabled={!canEdit}
                          />
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove ${label} range`}
                              onClick={() => removeRange(key, i)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </div>
                      ))}
                      {canEdit && (
                        <Button variant="ghost" size="sm" onClick={() => addRange(key)}>
                          <Plus className="mr-1 size-4" /> Add
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {canEdit && (
            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Save changes
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
