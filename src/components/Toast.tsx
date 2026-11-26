import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface ToastItem {
  id: string;
  message: string;
  tone: 'ok' | 'error' | 'info';
}

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div
      className="fixed bottom-5 right-5 z-50 flex flex-col gap-2.5 max-w-sm w-[calc(100vw-2.5rem)] pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto artena-enter flex items-start justify-between gap-3 px-4 py-3 rounded-xl border text-xs font-medium shadow-lg backdrop-blur-md transition-all ${
            t.tone === 'error'
              ? 'bg-red-50/95 dark:bg-red-950/95 border-red-200 dark:border-red-800/80 text-red-900 dark:text-red-100'
              : t.tone === 'ok'
                ? 'bg-white/95 dark:bg-slate-900/95 border-teal-200 dark:border-teal-800/70 text-slate-900 dark:text-slate-100'
                : 'bg-white/95 dark:bg-slate-900/95 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
          }`}
        >
          <div className="flex items-start gap-2.5 min-w-0">
            {t.tone === 'error' ? (
              <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
            ) : t.tone === 'ok' ? (
              <CheckCircle2 className="w-4 h-4 text-teal-600 dark:text-teal-400 shrink-0 mt-0.5" />
            ) : (
              <Info className="w-4 h-4 text-slate-500 dark:text-slate-400 shrink-0 mt-0.5" />
            )}
            <span className="leading-relaxed break-words">{t.message}</span>
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss notification"
            className="p-1 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
