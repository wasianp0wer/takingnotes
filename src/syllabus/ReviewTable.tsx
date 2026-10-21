import { Input } from '@/components/ui/input';
import type { ReviewRow } from '@/syllabus/reviewRows';

export interface ReviewTableProps {
  rows: ReviewRow[];
  onChange(id: string, patch: Partial<ReviewRow>): void;
}

/**
 * The mandatory review table (A25): nothing reaches the calendar until the user
 * has seen this and confirmed, even when every row parsed cleanly. A row with no
 * resolvable date shows an empty date and cannot be included until one is typed
 * (A27).
 */
export function ReviewTable({ rows, onChange }: ReviewTableProps) {
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs text-muted-foreground">
        <tr>
          <th scope="col" className="p-1">Add</th>
          <th scope="col" className="p-1">Assignment</th>
          <th scope="col" className="p-1">Due</th>
          <th scope="col" className="p-1">Time</th>
          <th scope="col" className="p-1">Required</th>
          <th scope="col" className="p-1">Minutes</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} className="align-top">
            <td className="p-1">
              <input
                type="checkbox"
                aria-label={`Include ${row.title}`}
                checked={row.include}
                disabled={row.dueDate === ''}
                onChange={(e) => onChange(row.id, { include: e.target.checked })}
              />
            </td>
            <td className="p-1">
              {/* An <input>'s value is not text content, so the row's identity is
                  also rendered as plain text here - both for a sighted user
                  scanning the table and so extracted rows are provably visible. */}
              <div className="text-sm font-medium">{row.title === '' ? '(untitled)' : row.title}</div>
              <Input
                aria-label={`Title for ${row.title}`}
                value={row.title}
                onChange={(e) => onChange(row.id, { title: e.target.value })}
                className="mt-1"
              />
              {row.existing && (
                <span className="text-xs text-muted-foreground">Already imported — will update</span>
              )}
              {row.dueDate === '' && (
                <span className="block text-xs text-destructive">
                  No date{row.rawDate === '' ? '' : ` in "${row.rawDate}"`} — enter one to include it
                </span>
              )}
            </td>
            <td className="p-1">
              <Input
                type="date"
                aria-label={`Due date for ${row.title}`}
                value={row.dueDate}
                onChange={(e) => {
                  const value = e.target.value;
                  const hadNoDate = row.dueDate === '';
                  onChange(row.id, {
                    dueDate: value,
                    edited: true,
                    // A27: a row starts excluded until it has a date; once one
                    // is entered it becomes includable on its own, rather than
                    // requiring a second, separate tick the "enter one to
                    // include it" message would otherwise be lying about.
                    // Clearing the date back out always excludes it again. An
                    // edit to an already-dated row leaves the user's own tick
                    // decision alone.
                    include: value === '' ? false : hadNoDate ? true : row.include,
                  });
                }}
              />
            </td>
            <td className="p-1">
              <Input
                type="time"
                aria-label={`Due time for ${row.title}`}
                value={row.dueTime}
                onChange={(e) => onChange(row.id, { dueTime: e.target.value, edited: true })}
              />
            </td>
            <td className="p-1">
              <input
                type="checkbox"
                aria-label={`Required for ${row.title}`}
                checked={row.required}
                onChange={(e) => onChange(row.id, { required: e.target.checked })}
              />
            </td>
            <td className="p-1">
              <Input
                aria-label={`Estimated minutes for ${row.title}`}
                inputMode="numeric"
                value={row.estimatedMinutes}
                onChange={(e) => onChange(row.id, { estimatedMinutes: e.target.value })}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
