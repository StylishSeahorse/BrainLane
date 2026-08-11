'use client';

import { useActionState, useState, useTransition } from 'react';
import {
  listAiModels,
  saveAiSettings,
  testAiConnection,
  type ActionState,
} from '@/app/actions';

export interface ProviderOption {
  id: string;
  label: string;
  blurb: string;
  requiresKey: boolean;
  editableBaseUrl: boolean;
  supportsModelListing: boolean;
  defaultModel: string;
  baseUrl: string;
  keyUrl: string | null;
  isCli: boolean;
  unverified: boolean;
  signIn: { command: string; install?: string; detail: string } | null;
}

export interface CurrentAiSettings {
  providerId: string;
  model: string;
  baseUrl: string;
  hasKey: boolean;
  allowScheduling: boolean;
  allowTaskBreakdown: boolean;
  allowAvoidanceCheck: boolean;
  allowChat: boolean;
  shareTaskText: boolean;
}

const CONSENTS = [
  {
    name: 'allowScheduling',
    label: 'Scheduling',
    detail: 'Sends durations, deadlines and categories. Never task titles.',
  },
  {
    name: 'allowTaskBreakdown',
    label: 'Task breakdown',
    detail: 'Sends the task you ask it to break down.',
  },
  {
    name: 'allowAvoidanceCheck',
    label: 'Avoidance check-ins',
    detail: 'The pattern detection itself is arithmetic and always runs, with or without this.',
  },
  { name: 'allowChat', label: 'Chat', detail: 'Conversational planning help.' },
] as const;

/**
 * Provider configuration.
 *
 * A client component because the form genuinely changes shape with the
 * selection: a self-hosted endpoint needs a URL field, Ollama needs no key at
 * all, and the model list can only be fetched once a provider and key exist.
 */
export function AiProviderForm({
  providers,
  current,
}: {
  providers: ProviderOption[];
  current: CurrentAiSettings;
}) {
  const [state, formAction, saving] = useActionState<ActionState, FormData>(
    saveAiSettings,
    undefined,
  );

  const [providerId, setProviderId] = useState(current.providerId);
  const [models, setModels] = useState<string[]>([]);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, startTransition] = useTransition();

  const provider = providers.find((entry) => entry.id === providerId) ?? providers[0]!;

  const runTest = () =>
    startTransition(async () => {
      setTestResult(await testAiConnection());
    });

  const loadModels = () =>
    startTransition(async () => {
      setModels(await listAiModels());
    });

  return (
    <form action={formAction} className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        {state?.error ? (
          <div role="alert" className="alert alert-error text-sm">
            <span>{state.error}</span>
          </div>
        ) : null}

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Provider</legend>
          <select
            name="providerId"
            className="select w-full"
            value={providerId}
            onChange={(event) => {
              setProviderId(event.target.value);
              // The old list belongs to the old provider; showing it against a
              // new one would offer models that do not exist there.
              setModels([]);
              setTestResult(null);
            }}
          >
            {/*
              Grouped so the keyless options read as a set. Scattered among a
              dozen key-based entries, "sign in with your ChatGPT account" is
              easy to miss entirely — which is exactly what happened before.
            */}
            <optgroup label="Sign in with an account">
              {providers
                .filter((entry) => entry.signIn)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Use an API key">
              {providers
                .filter((entry) => !entry.signIn)
                .map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
            </optgroup>
          </select>
          <p className="label text-xs">{provider.blurb}</p>
        </fieldset>

        {/*
          Sign-in providers get the command, not a button.

          Neither Anthropic nor OpenAI publishes an OAuth client that lets a
          third-party app spend a consumer subscription, so this app runs no
          OAuth flow of its own — it points at the official one and then uses
          the credentials that leaves behind. Showing the exact command is more
          honest, and more useful, than a button that could not work.
        */}
        {provider.signIn ? (
          <div className="border-primary/25 bg-primary/5 rounded-box space-y-2 border p-3">
            <p className="text-sm font-medium">Sign in once, in a terminal</p>
            <p className="text-base-content/60 text-xs">{provider.signIn.detail}</p>

            <pre className="bg-base-300/60 overflow-x-auto rounded-lg px-3 py-2 font-mono text-xs">
              <code>{provider.signIn.command}</code>
            </pre>

            {provider.signIn.install ? (
              <p className="text-base-content/50 text-xs">
                Not installed?{' '}
                <a
                  href={provider.signIn.install}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="link"
                >
                  Install instructions
                </a>
              </p>
            ) : null}
          </div>
        ) : null}

        {provider.editableBaseUrl && !provider.isCli ? (
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Endpoint URL</legend>
            <input
              name="baseUrl"
              type="url"
              defaultValue={current.baseUrl || provider.baseUrl}
              placeholder="http://localhost:11434/v1"
              className="input w-full font-mono text-sm"
            />
            <p className="label text-xs">
              Must be https, unless it is on localhost. Private and internal addresses are refused.
            </p>
          </fieldset>
        ) : provider.isCli ? (
          <div className="bg-base-200 rounded-box space-y-1 p-3 text-xs">
            <p>
              Runs <code className="font-mono">{provider.id === 'codex' ? 'codex' : 'claude'}</code>{' '}
              on this machine, using the login it already has. Only works where the app and the CLI
              run on the same computer.
            </p>
            <p className="text-base-content/50">
              Tool access is switched off for these calls, so nothing in a calendar invite can reach
              your files or shell.
            </p>
            {provider.unverified ? (
              <p className="text-warning">
                Not yet verified against a live install — run Test connection before relying on it.
              </p>
            ) : null}
          </div>
        ) : provider.signIn ? null : (
          <p className="text-base-content/45 text-xs">
            Endpoint: <code className="font-mono">{provider.baseUrl}</code>
          </p>
        )}

        {!provider.isCli && (provider.requiresKey || provider.editableBaseUrl) ? (
          <fieldset className="fieldset">
            <legend className="fieldset-legend">
              API key {provider.requiresKey ? '' : '(optional)'}
            </legend>
            <input
              name="apiKey"
              type="password"
              autoComplete="off"
              placeholder={current.hasKey ? '•••••••• stored — type to replace' : 'sk-…'}
              className="input w-full font-mono text-sm"
            />
            <p className="label text-xs">
              Encrypted at rest and never sent back to the browser.{' '}
              {provider.keyUrl ? (
                <a
                  href={provider.keyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="link"
                >
                  Get a key
                </a>
              ) : null}
            </p>

            {current.hasKey ? (
              <label className="label cursor-pointer justify-start gap-2">
                <input name="clearKey" type="checkbox" className="checkbox checkbox-sm" />
                <span className="label-text text-xs">Remove the stored key</span>
              </label>
            ) : null}
          </fieldset>
        ) : null}

        <fieldset className="fieldset">
          <legend className="fieldset-legend">Model</legend>
          <input
            name="model"
            list="ai-model-options"
            defaultValue={current.model}
            placeholder={provider.defaultModel || 'Model name'}
            className="input w-full font-mono text-sm"
          />
          <datalist id="ai-model-options">
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>

          <div className="flex flex-wrap items-center gap-2">
            {provider.supportsModelListing ? (
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={loadModels}
                disabled={busy}
              >
                {models.length > 0 ? `${models.length} models loaded` : 'Load available models'}
              </button>
            ) : null}
            <span className="text-base-content/40 text-xs">
              Any model name works — the list is fetched from the provider, not baked in.
            </span>
          </div>
        </fieldset>

        <div className="divider my-0" />

        <div>
          <p className="mb-2 text-sm font-medium">What this provider is allowed to see</p>
          <ul className="divide-base-200 divide-y">
            {CONSENTS.map((consent) => (
              <li key={consent.name} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="text-sm font-medium">{consent.label}</div>
                  <p className="text-base-content/50 text-xs">{consent.detail}</p>
                </div>
                <input
                  type="checkbox"
                  name={consent.name}
                  defaultChecked={current[consent.name]}
                  className="toggle toggle-sm toggle-primary shrink-0"
                />
              </li>
            ))}

            <li className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium">Share task titles and notes</div>
                <p className="text-base-content/50 text-xs">
                  Off by default. With this off the model reasons about structure — durations,
                  deadlines, categories — and never sees your own words.
                </p>
              </div>
              <input
                type="checkbox"
                name="shareTaskText"
                defaultChecked={current.shareTaskText}
                className="toggle toggle-sm toggle-primary shrink-0"
              />
            </li>
          </ul>
        </div>

        {testResult ? (
          <div
            role="status"
            className={`alert alert-soft text-sm ${testResult.ok ? 'alert-success' : 'alert-warning'}`}
          >
            <span>{testResult.message}</span>
          </div>
        ) : null}

        <div className="card-actions">
          <button type="submit" className="btn btn-primary btn-sm rounded-xl" disabled={saving}>
            {saving ? <span className="loading loading-spinner loading-xs" /> : null}
            Save
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm rounded-xl"
            onClick={runTest}
            disabled={busy}
          >
            {busy ? <span className="loading loading-spinner loading-xs" /> : null}
            Test connection
          </button>
        </div>
      </div>
    </form>
  );
}
