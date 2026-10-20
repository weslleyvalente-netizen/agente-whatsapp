import unittest
from add_financing_card import add_card, CARD, DESTINATION

class CardTests(unittest.TestCase):
    def test_preserves_all_existing_markup(self):
        original='<div class="portal-tools"><a href="/grupos">Grupos</a><a href="https://lances.motoetrilha.com.br">Lances</a></div><p class="portal-note" id="update">Atualização</p>'
        changed=add_card(original)
        self.assertIn(DESTINATION,changed)
        self.assertEqual(changed.replace(CARD,''),original)
        self.assertEqual(add_card(changed),changed)
    def test_refuses_unrecognized_structure(self):
        with self.assertRaises(ValueError):add_card('<main>Outra versão</main>')

if __name__=='__main__':unittest.main()
