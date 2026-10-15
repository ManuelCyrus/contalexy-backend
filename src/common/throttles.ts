/// Limites de pedidos por rota (por IP, por minuto), além do limite geral.
export const THROTTLE = {
  /// Entrar, registar, recuperar palavra-passe
  strict: { default: { limit: 10, ttl: 60_000 } },
  /// Carregar ficheiros (recibos, fotos, logótipos)
  uploads: { default: { limit: 20, ttl: 60_000 } },
  /// Convites, pedidos a outras pessoas, feedback
  social: { default: { limit: 15, ttl: 60_000 } },
  /// Pesquisas e sugestões (escreve-se letra a letra)
  search: { default: { limit: 90, ttl: 60_000 } },
  /// Exportações e relatórios pesados
  heavy: { default: { limit: 10, ttl: 60_000 } },
} as const;
