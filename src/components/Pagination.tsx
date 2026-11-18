import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export const DEFAULT_PAGE_SIZE = 5;

export function usePagination<T>(items: T[], resetSignature = '', pageSize = DEFAULT_PAGE_SIZE) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [resetSignature]);

  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);

  const pagedItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, safePage, pageSize]);

  const startIndex = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endIndex = Math.min(totalItems, safePage * pageSize);

  return {
    page: safePage,
    setPage,
    totalPages,
    totalItems,
    pageSize,
    pagedItems,
    startIndex,
    endIndex,
  };
}

interface PaginationProps {
  page: number;
  totalItems: number;
  pageSize?: number;
  onPageChange: (nextPage: number) => void;
  compact?: boolean;
  className?: string;
}

export function Pagination({
  page,
  totalItems,
  pageSize = DEFAULT_PAGE_SIZE,
  onPageChange,
  compact = false,
  className = '',
}: PaginationProps) {
  if (totalItems === 0) return null;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(totalItems, safePage * pageSize);

  const pageTokens = useMemo(() => {
    const tokens: Array<number | 'ellipsis-left' | 'ellipsis-right'> = [];
    if (totalPages <= 5) {
      for (let i = 1; i <= totalPages; i++) tokens.push(i);
      return tokens;
    }
    tokens.push(1);
    if (safePage > 3) tokens.push('ellipsis-left');
    const winStart = Math.max(2, safePage - 1);
    const winEnd = Math.min(totalPages - 1, safePage + 1);
    for (let i = winStart; i <= winEnd; i++) tokens.push(i);
    if (safePage < totalPages - 2) tokens.push('ellipsis-right');
    tokens.push(totalPages);
    return tokens;
  }, [safePage, totalPages]);

  return (
    <div
      className={`flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 bg-[#0F172A]/80 ${
        compact ? 'px-3 py-2' : 'px-4 py-2.5'
      } text-[11px] text-slate-400 ${className}`}
    >
      <span className="font-mono tabular-nums whitespace-nowrap">
        {compact ? `${start}–${end} de ${totalItems}` : `Mostrando ${start}–${end} de ${totalItems}`}
      </span>

      <div className="flex items-center gap-1">
        <button
          type="button"
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
          aria-label="Página anterior"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-800 bg-[#0B1120] text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
          {!compact && <span>Anterior</span>}
        </button>

        {!compact &&
          pageTokens.map((tok) =>
            typeof tok === 'number' ? (
              <button
                key={tok}
                type="button"
                onClick={() => onPageChange(tok)}
                aria-current={tok === safePage ? 'page' : undefined}
                className={`min-w-[26px] px-1.5 py-1 rounded-md font-mono tabular-nums text-[11px] transition-colors cursor-pointer ${
                  tok === safePage
                    ? 'bg-sky-600 text-white font-semibold'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800'
                }`}
              >
                {tok}
              </button>
            ) : (
              <span key={tok} className="px-1 text-slate-600 select-none">
                …
              </span>
            )
          )}

        {compact && (
          <span className="px-1.5 font-mono tabular-nums text-slate-300 whitespace-nowrap">
            {safePage}/{totalPages}
          </span>
        )}

        <button
          type="button"
          disabled={safePage >= totalPages}
          onClick={() => onPageChange(safePage + 1)}
          aria-label="Página siguiente"
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-slate-800 bg-[#0B1120] text-slate-300 hover:bg-slate-800 hover:text-white disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer transition-colors whitespace-nowrap"
        >
          {!compact && <span>Siguiente</span>}
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
