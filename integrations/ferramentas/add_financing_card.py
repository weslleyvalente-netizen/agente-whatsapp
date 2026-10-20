"""Apply only the financing card to the current portal, preserving unrelated updates."""
from pathlib import Path
import argparse

DESTINATION = 'https://crm.motoetrilha.com.br/financiamento'
CARD = '''<a class="portal-tool" href="https://crm.motoetrilha.com.br/financiamento"><div class="portal-tool-top"><svg class="portal-icon" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 10h18M5 10v9m5-9v9m4-9v9m5-9v9M3 21h18M2 7l10-5 10 5z"/></svg><span class="portal-access restricted">Login do CRM · Testes</span></div><h2>Consulta de financiamento</h2><p>Prepare a ficha do cliente e acompanhe os resultados por banco no ambiente de testes.</p><span class="portal-action">Abrir consultas<span aria-hidden="true">↗</span></span></a>'''


def add_card(source: str) -> str:
    if DESTINATION in source:
        return source
    anchor = '</div><p class="portal-note" id="update">'
    if source.count(anchor) != 1 or 'class="portal-tools"' not in source:
        raise ValueError('Estrutura do portal mudou. Revisar antes de aplicar.')
    return source.replace(anchor, CARD + anchor, 1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    if args.source.resolve() == args.output.resolve():
        parser.error('Use outro arquivo de saída e revise o diff antes de publicar.')
    args.output.write_text(add_card(args.source.read_text()))
