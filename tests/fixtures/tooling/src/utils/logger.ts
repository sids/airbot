export function logger(message: string): void {
  console.log(`[fixture] ${message}`);
}

export const patterns = {
  greeting: /hello/i,
};
