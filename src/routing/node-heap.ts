// A binary min-heap over parallel key/id arrays, grown by doubling. Stale entries are left in
// place and skipped on pop (lazy deletion), which is cheaper than sifting on every relaxation.
export class NodeHeap {
  private keys: Float64Array;
  private ids: Uint32Array;
  private size = 0;

  constructor(capacity: number) {
    this.keys = new Float64Array(capacity);
    this.ids = new Uint32Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.size = 0;
  }

  push(key: number, id: number): void {
    if (this.size === this.keys.length) {
      const grownKeys = new Float64Array(this.keys.length * 2);
      const grownIds = new Uint32Array(this.ids.length * 2);
      grownKeys.set(this.keys);
      grownIds.set(this.ids);
      this.keys = grownKeys;
      this.ids = grownIds;
    }
    let child = this.size;
    this.keys[child] = key;
    this.ids[child] = id;
    this.size += 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.keys[parent] <= this.keys[child]) {
        break;
      }
      this.swap(parent, child);
      child = parent;
    }
  }

  peekKey(): number {
    return this.keys[0];
  }

  pop(): number {
    const id = this.ids[0];
    this.size -= 1;
    this.keys[0] = this.keys[this.size];
    this.ids[0] = this.ids[this.size];
    let parent = 0;
    for (;;) {
      const left = 2 * parent + 1;
      const right = left + 1;
      let smallest = parent;
      if (left < this.size && this.keys[left] < this.keys[smallest]) {
        smallest = left;
      }
      if (right < this.size && this.keys[right] < this.keys[smallest]) {
        smallest = right;
      }
      if (smallest === parent) {
        break;
      }
      this.swap(parent, smallest);
      parent = smallest;
    }
    return id;
  }

  private swap(left: number, right: number): void {
    const key = this.keys[left];
    this.keys[left] = this.keys[right];
    this.keys[right] = key;
    const id = this.ids[left];
    this.ids[left] = this.ids[right];
    this.ids[right] = id;
  }
}
