const fs = require('fs');
const path = require('path');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle } = require('docx');

async function generateDocx() {
  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 1440, // 1 inch
              right: 1440,
              bottom: 1440,
              left: 1440,
            },
          },
        },
        children: [
          // Título Principal
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
            children: [
              new TextRun({
                text: "iFood Lead Hunter Pro",
                bold: true,
                size: 44, // 22pt
                color: "EA1D2C",
                font: "Calibri",
              }),
            ],
          }),

          // Subtítulo
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
            children: [
              new TextRun({
                text: "Manual de Uso e Guia de Funcionalidades - Prospecção na Grande São Paulo",
                italics: true,
                size: 24, // 12pt
                color: "475569",
                font: "Calibri",
              }),
            ],
          }),

          // Divisor
          new Paragraph({
            spacing: { after: 300 },
            border: {
              bottom: {
                color: "CBD5E1",
                space: 1,
                style: BorderStyle.SINGLE,
                size: 6,
              },
            },
          }),

          // 1. VISÃO GERAL
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 240, after: 160 },
            children: [
              new TextRun({
                text: "1. Visão Geral da Aplicação",
                bold: true,
                size: 28,
                color: "0F172A",
                font: "Calibri",
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 140 },
            children: [
              new TextRun({
                text: "O ",
                font: "Calibri",
                size: 22,
              }),
              new TextRun({
                text: "iFood Lead Hunter Pro",
                bold: true,
                font: "Calibri",
                size: 22,
                color: "EA1D2C",
              }),
              new TextRun({
                text: " é uma plataforma completa e moderna desenvolvida sob medida para prospecção ativa de estabelecimentos gastronômicos (hamburguerias, pizzarias, lanchonetes, restaurantes, marmitarias, etc.) em toda a Grande São Paulo.",
                font: "Calibri",
                size: 22,
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: "O objetivo da ferramenta é encontrar restaurantes com alto potencial de compra para serviços de consultoria, otimização de cardápio, fotos conversivas, estratégias para conquistar o selo Super Restaurante e alavancagem de vendas no iFood, conectando-se diretamente à versão mais recente da Google Places API.",
                font: "Calibri",
                size: 22,
              }),
            ],
          }),

          // 2. O QUE TEM NA APLICAÇÃO
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 160 },
            children: [
              new TextRun({
                text: "2. O Que Tem na Aplicação (Recursos e Funcionalidades)",
                bold: true,
                size: 28,
                color: "0F172A",
                font: "Calibri",
              }),
            ],
          }),

          createFeatureItem("Barra de Busca Inteligente", "Permite digitar qualquer termo livre (Ex: 'Hamburguerias em Pinheiros SP', 'Pizzarias em Santo André', etc.) com suporte a atalho na tecla Enter e botão de limpeza rápida."),
          createFeatureItem("Filtros Rápidos de Nichos Gastronômicos (1 Clique)", "Botões dedicados para Hamburguerias, Pizzarias, Lanchonetes & Petiscarias, Marmitarias / PF, Restaurantes Japoneses, Açaí & Sobremesas e Comida Caseira / Bar."),
          createFeatureItem("Filtros de Bairros e Cidades da Grande SP (1 Clique)", "Atalhos rápidos para Pinheiros, Vila Mariana, Santo Amaro, Moema, Itaim Bibi, Tatuapé, Santana, Santo André, São Bernardo, Guarulhos, Osasco e Barueri / Alphaville."),
          createFeatureItem("Painel de Métricas em Tempo Real", "Exibe instantaneamente o Total de Leads Encontrados, Volume de Leads 'Alta Oportunidade', Estabelecimentos com Telefone/WhatsApp válido e a Média das Notas do Google."),
          createFeatureItem("Algoritmo de 'Alta Oportunidade' para Consultoria", "Destaca com badge pulsante restaurantes com nota < 4.5 ou menos de 60 avaliações no Google. O sistema já gera automaticamente um diagnóstico explicando o ponto fraco do restaurante (risco de cancelamento, nota mediana para virar Super Restaurante ou baixa tração de pedidos)."),
          createFeatureItem("Botão Direto 'Chamar no WhatsApp'", "Formata o telefone brasileiro para DDI 55 + DDD + Número e abre a conversa direta já com uma abordagem persuasiva personalizada com o nome do estabelecimento."),
          createFeatureItem("Botão 'Copiar Pitch'", "Copia a mensagem personalizada de abordagem comercial para a área de transferência com um único clique e feedback visual via notificação toast."),
          createFeatureItem("Modal 'Personalizar Pitch'", "Permite alterar o nome do consultor (padrão: Felipe) e escolher entre 4 modelos de abordagem comercial: Escala Geral, Recuperação de Nota Baixa, Engenharia de Cardápio e Começando no iFood."),
          createFeatureItem("Gestor de Funil de Leads (Salvo no Navegador)", "Seletor integrado para marcar cada lead como Pendente, Contatado, Respondeu ou Fechado, persistindo tudo no localStorage do seu computador."),
          createFeatureItem("Duas Visualizações (Cards e Tabela)", "Permite alternar entre o modo Cards (visual rico com estrelas, badges e endereço) e o modo Tabela (estilo planilha para triagem rápida em lote)."),
          createFeatureItem("Exportação para Excel (CSV com UTF-8 BOM)", "Exporta todos os leads minerados com um clique. Possui codificação especial UTF-8 BOM para abrir com 100% de precisão no Excel sem corromper acentos ou caracteres em português."),

          // 3. PASSO A PASSO
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 160 },
            children: [
              new TextRun({
                text: "3. Passo a Passo: Como Usar no Dia a Dia",
                bold: true,
                size: 28,
                color: "0F172A",
                font: "Calibri",
              }),
            ],
          }),

          createStepItem("Passo 1: Iniciar o Sistema", "Dê dois cliques no arquivo 'iniciar.bat' na pasta do projeto. O servidor subirá e seu navegador abrirá automaticamente em http://localhost:3000."),
          createStepItem("Passo 2: Configurar Seu Pitch de Vendas", "Clique no botão 'Personalizar Pitch' no canto superior direito. Verifique seu nome e selecione o modelo de abordagem que melhor combina com sua estratégia."),
          createStepItem("Passo 3: Fazer uma Busca de Leads", "Clique em um nicho (Ex: 'Hamburguerias') e depois em um bairro/cidade (Ex: 'Pinheiros') ou digite livremente o que deseja na barra de pesquisa."),
          createStepItem("Passo 4: Filtrar os Melhores Clientes", "Use as abas 'Alta Oportunidade' (para focar nos restaurantes que mais precisam de ajuda) ou 'Com WhatsApp'. Ordene também por 'Menor Nota' para abordar os mais urgentes."),
          createStepItem("Passo 5: Abordar os Leads", "Clique em 'Chamar no WhatsApp' para iniciar o contato ou em 'Copiar Pitch' para enviar no Instagram Direct ou e-mail. Altere o status do lead para 'Contatado'."),
          createStepItem("Passo 6: Exportar para Excel", "Clique no botão 'Exportar CSV' para baixar a lista completa com telefones e links. Excelente para integrar com disparadores como o Sender Agily!"),

          // 4. ESTRUTURA DOS ARQUIVOS
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 300, after: 160 },
            children: [
              new TextRun({
                text: "4. Estrutura dos Arquivos",
                bold: true,
                size: 28,
                color: "0F172A",
                font: "Calibri",
              }),
            ],
          }),

          createBulletPoint("iniciar.bat: Arquivo executável de dois cliques para iniciar o servidor e abrir a aplicação no navegador."),
          createBulletPoint("server.js: Código backend em Node.js com a rota /api/search que consulta a Google Places API."),
          createBulletPoint("public/index.html: Interface do usuário (Dashboard Dark, Tailwind CSS, JavaScript e FontAwesome)."),
          createBulletPoint(".env: Arquivo de configuração contendo sua chave de API e a porta 3000."),
          createBulletPoint("docs/MANUAL_DE_USO.docx: Este manual no formato oficial do Microsoft Word."),
          createBulletPoint("docs/MANUAL_DE_USO.txt: Versão em texto puro para visualização em qualquer bloco de notas."),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const outputPath = path.join(__dirname, 'MANUAL_DE_USO.docx');
  fs.writeFileSync(outputPath, buffer);
  console.log('DOCX gerado com sucesso em:', outputPath);
}

function createFeatureItem(title, description) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: "• " + title + ": ",
        bold: true,
        size: 22,
        color: "0284C7", // Cyan/Blue
        font: "Calibri",
      }),
      new TextRun({
        text: description,
        size: 22,
        font: "Calibri",
      }),
    ],
  });
}

function createStepItem(stepTitle, stepDescription) {
  return new Paragraph({
    spacing: { after: 140 },
    children: [
      new TextRun({
        text: stepTitle + " — ",
        bold: true,
        size: 22,
        color: "EA1D2C", // Red
        font: "Calibri",
      }),
      new TextRun({
        text: stepDescription,
        size: 22,
        font: "Calibri",
      }),
    ],
  });
}

function createBulletPoint(text) {
  return new Paragraph({
    spacing: { after: 100 },
    children: [
      new TextRun({
        text: "✔ " + text,
        size: 22,
        font: "Calibri",
      }),
    ],
  });
}

generateDocx().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
