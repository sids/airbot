export function greet(name: string): string {
  const message = `Hello, ${name}!`;
  console.log(message);
  return message;
}

export function repeatGreeting(name: string, times: number): string[] {
  if (times < 1) {
    return [];
  }
  return Array.from({ length: times }, () => greet(name));
}
