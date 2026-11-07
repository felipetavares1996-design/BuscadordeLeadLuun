# iFood Lead Hunter Pro - Grande São Paulo

Aplicação completa de prospecção e inteligência de mercado para restaurantes, hamburguerias, pizzarias e lanchonetes na Grande São Paulo, focada em consultoria e aumento de vendas no iFood.

---

## 🚀 Como Executar

1. **Instalar dependências** (caso ainda não tenham sido instaladas):
   ```bash
   npm install
   ```

2. **Verificar o arquivo `.env` na raiz**:
   ```env
   GOOGLE_PLACES_API_KEY=AIzaSyArbkK1XYyV6kSxCzojqKOV-ItRaRmhm_Y
   PORT=3000
   ```

3. **Iniciar o servidor**:
   ```bash
   npm start
   ```

4. **Acessar no navegador**:
   [http://localhost:3000](http://localhost:3000)

---

## 🛠️ Recursos Implementados

### 1. Backend (Node.js + Express)
- **Google Places API (New)**: Integração com `https://places.googleapis.com/v1/places:searchText`.
- **FieldMask**: `places.displayName`, `places.formattedAddress`, `places.nationalPhoneNumber`, `places.websiteUri`, `places.rating`, `places.userRatingCount`, `places.googleMapsUri`.
- **Tratamento de Contatos**: Normalização de telefones brasileiros para links diretos de WhatsApp (`55 + DDD + Número`).
- **Algoritmo de Oportunidade iFood**:
  - Classificação inteligente para estabelecimentos com **nota < 4.5** ou **baixo volume de avaliações (< 60)**, que são os perfis de maior conversão para consultoria de cardápio, fotos e posicionamento no iFood.

### 2. Frontend (HTML5, Tailwind CSS, FontAwesome e JavaScript Vanilla)
- **Dashboard Dark Moderno**: Tons `slate-950`/`zinc-900` com acentos em Esmeralda, Cyan e Vermelho iFood.
- **Filtros Rápidos em 1 Clique**:
  - **Nichos**: Hamburguerias, Pizzarias, Lanchonetes, Marmitarias / PF, Japoneses, Açaí & Sobremesas, Comida Caseira.
  - **Regiões Grande SP**: Pinheiros, Vila Mariana, Santo Amaro, Moema, Itaim Bibi, Tatuapé, Santana, Santo André, São Bernardo, Guarulhos, Osasco, Barueri / Alphaville.
- **Painel de Métricas em Tempo Real**:
  - Total de Leads Encontrados
  - Leads "Alta Oportunidade"
  - Estabelecimentos com WhatsApp ativo
  - Média geral de notas
- **Duas Visualizações**:
  - **Cards**: Visual rico com badges, estrelas, endereço e ações.
  - **Tabela**: Modo planilha para triagem rápida.
- **Ações Imediatas de Prospecção**:
  - **Chamar no WhatsApp**: Abre chat direto no WhatsApp com mensagem personalizada contendo o nome do restaurante.
  - **Copiar Pitch Personalizado**: Copia mensagem persuasiva de abordagem comercial com 1 clique.
  - **Personalizar Pitch**: Modal interativo para mudar nome do consultor e alternar entre 4 modelos de abordagem (Escala Geral, Recuperação de Notas, Engenharia de Cardápio e Começando no iFood).
  - **Exportar CSV**: Download imediato em UTF-8 com BOM para abertura sem erros de codificação no Microsoft Excel.
  - **Gestão de Status**: Salva localmente o status de prospecção (Pendente, Contatado, Respondeu, Fechado) via `localStorage`.
