import { DomainError } from '../errors/DomainError.js';

export type EnsSubnameRequest = {
  name: string;
};

export type ValidatedEnsSubname = {
  name: string;
  label: string;
  parentName: string;
};

export class EnsSubnamePolicy {
  validate(request: EnsSubnameRequest): ValidatedEnsSubname {
    const name = request.name.trim().toLowerCase();
    const parts = name.split('.');

    if (
      parts.length !== 3 ||
      parts[2] !== 'eth' ||
      !isLabel(parts[0] ?? '') ||
      !isLabel(parts[1] ?? '')
    ) {
      throw new DomainError(
        'ENS subname must have the form label.parent.eth using letters, numbers, or inner hyphens',
      );
    }

    const [label, parent] = parts as [string, string, 'eth'];
    return {
      name: `${label}.${parent}.eth`,
      label,
      parentName: `${parent}.eth`,
    };
  }
}

function isLabel(value: string): boolean {
  return (
    value.length <= 63 && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)
  );
}
