import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download } from 'lucide-react';
import { copyToClipboard } from '../lib/api';

export function QrCodeCanvas({
  value,
  size = 204,
  label,
}: {
  value: string;
  size?: number;
  label?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canvasRef.current || !value) return;
    QRCode.toCanvas(canvasRef.current, value, {
      width: size,
      margin: 2,
      color: { dark: '#0A131C', light: '#FFFFFF' },
    }).catch(() => {
      // Ignore QR encode error on oversized input
    });
  }, [value, size]);

  const handleCopy = async () => {
    if (await copyToClipboard(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const handleDownload = () => {
    if (!canvasRef.current) return;
    const link = document.createElement('a');
    link.download = `${(label || 'artena-config').replace(/[^\w-]+/g, '_')}.png`;
    link.href = canvasRef.current.toDataURL('image/png');
    link.click();
  };

  return (
    <div className="flex flex-col items-center gap-3.5">
      <div className="p-3.5 bg-white rounded-2xl border border-slate-200 dark:border-slate-700 shadow-sm">
        <canvas ref={canvasRef} width={size} height={size} className="block rounded-lg" />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="h-9 px-3.5 rounded-lg bg-gradient-to-b from-[#E8AE5C] to-[#D08F35] hover:from-[#F0BC70] hover:to-[#DC9E49] text-[#0A131C] font-semibold shadow-[0_2px_10px_-2px_rgba(225,159,72,0.45)] text-xs font-medium inline-flex items-center gap-1.5 transition-colors shadow-sm shadow-teal-600/15 whitespace-nowrap"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy URI'}
        </button>
        <button
          type="button"
          onClick={handleDownload}
          className="h-9 px-3.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 text-xs font-medium inline-flex items-center gap-1.5 hover:bg-slate-50 dark:hover:bg-slate-700/80 transition-colors whitespace-nowrap"
        >
          <Download className="w-3.5 h-3.5" />
          Save PNG
        </button>
      </div>
    </div>
  );
}
