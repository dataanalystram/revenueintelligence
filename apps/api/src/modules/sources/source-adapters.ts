import { Inject, Injectable, Optional } from '@nestjs/common';
import type { SourceAdapterFactory } from '../domain';
import { AdapterNotRegisteredError } from './errors';

/** Adapter factories registered by the composition root (ADR 0019 §4). */
export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');

@Injectable()
export class SourceAdapterRegistry {
  private readonly byKind = new Map<string, SourceAdapterFactory>();

  constructor(
    @Optional() @Inject(SOURCE_ADAPTERS) factories: readonly SourceAdapterFactory[] = [],
  ) {
    for (const factory of factories) {
      if (this.byKind.has(factory.kind)) {
        throw new Error(`two source adapters registered for kind ${factory.kind}`);
      }
      this.byKind.set(factory.kind, factory);
    }
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  /** The factory for a kind; refuses (adapter_not_registered) when none is registered. */
  get(kind: string): SourceAdapterFactory {
    const factory = this.byKind.get(kind);
    if (!factory) throw new AdapterNotRegisteredError(kind);
    return factory;
  }

  kinds(): string[] {
    return [...this.byKind.keys()].sort();
  }
}
