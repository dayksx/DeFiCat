import type { EnsDropWatch } from '../../../../domain/ens/EnsDropWatch.js';

/**
 * Argument du workflow. Alias nommé plutôt qu'usage direct d'`EnsDropWatch` :
 * les arguments d'un workflow sont un contrat versionné, relu depuis
 * l'historique par des exécutions démarrées des mois plus tôt. Le jour où le
 * domaine évolue, c'est ici que la compatibilité se gère.
 */
export type WatchEnsDropInput = EnsDropWatch;
