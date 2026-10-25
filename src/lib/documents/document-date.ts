// ORDERDATE (DDMMYYYY) and ORDERTIME (HHMMSS) of fiscal documents. Both use the local time of
// the Date given; pass the server-time estimate when document times follow the server.

export function formatOrderDate(date: Date): string {
  return `${pad2(date.getDate())}${pad2(date.getMonth() + 1)}${date.getFullYear()}`;
}

export function formatOrderTime(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

export interface OrderDateTimeParts {
  year: string;
  month: string;
  day: string;
  hours: string;
  minutes: string;
  seconds: string;
}

// Splits ORDERDATE and ORDERTIME into their parts. Values parsed from XML as numbers have
// lost their leading zero (01102026 -> 1102026, 093005 -> 93005); it is restored.
export function parseOrderDateTime(
  orderDate: string | number,
  orderTime: string | number,
): OrderDateTimeParts {
  const date = String(orderDate ?? '').padStart(8, '0');
  const time = String(orderTime ?? '').padStart(6, '0');
  return {
    year: date.slice(-4),
    month: date.slice(-6, -4),
    day: date.slice(0, -6),
    hours: time.slice(0, -4),
    minutes: time.slice(-4, -2),
    seconds: time.slice(-2),
  };
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}
