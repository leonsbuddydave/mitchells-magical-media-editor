const PALETTE = ['#7fb6e8', '#8fd19e', '#e8b37a', '#d39be0', '#e89a9a', '#8fd6cf', '#c6cc7e', '#a6a9ec']

export function clipColor(index: number): string {
  return PALETTE[index % PALETTE.length]
}
