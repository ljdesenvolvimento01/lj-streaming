

// ==================================================

// LJ STREAMING - SISTEMA PRINCIPAL

// Catálogo + Cache + Pesquisa + Player + LJ PREMIUM

// ==================================================

"use strict";

// ==================================================

// ELEMENTOS DA INTERFACE

// ==================================================

const conteudo = document.getElementById("conteudo");

const titulo = document.getElementById("titulo");

const categorias = document.getElementById("categorias");

const pesquisa = document.getElementById("pesquisa");

const contador = document.getElementById("contador");

const modal = document.getElementById("modal");

const modalBody = document.getElementById("modal-body");

const modalContent = document.querySelector(".modal-content");

// ==================================================

// CONFIGURAÇÕES

// ==================================================

const CONFIG = {

          pageSize: 60,

          cacheCatalogo: 5 * 60 * 1000,

          cacheCategorias: 10 * 60 * 1000,

          cacheDetalhes: 10 * 60 * 1000,

          searchDelay: 180

};

// ==================================================

// ESTADO DA APLICAÇÃO

// ==================================================

const state = {

          page: "home",

          catalog: "movies",

          items: [],

          categories: [],

          categoryId: "",

          search: "",

          visibleCount: CONFIG.pageSize,

          requestId: 0

};

let usuarioAtual = null;
let bibliotecaAtual = { favorites: [], progress: [] };
let reproduccaoAtual = null;
let ultimoSalvamentoProgresso = 0;

const caches = {

          items: new Map(),

          categories: new Map(),

          details: new Map()

};

// ==================================================

// CACHE

// ==================================================

function limparCacheAntigo(cache, limite) {

          const agora = Date.now();

          for (const [key, entry] of cache.entries()) {

                    if (!entry.promise && entry.expiresAt <= agora) {

                              cache.delete(key);

                    }

          }

          while (cache.size > limite) {

                    let chaveAntiga = null;

                    let menorUso = Infinity;

                    for (const [key, entry] of cache.entries()) {

                              if (!entry.promise && entry.lastUsed < menorUso) {

                                        menorUso = entry.lastUsed;

                                        chaveAntiga = key;

                              }

                    }

                    if (chaveAntiga === null) break;

                    cache.delete(chaveAntiga);

          }

}

async function obterComCache(cache, key, loader, ttl, limite = 12) {

          const agora = Date.now();

          const existente = cache.get(key);

          if (existente) {

                    if (existente.promise) {

                              return existente.promise;

                    }

                    if (existente.expiresAt > agora) {

                              existente.lastUsed = agora;

                              return existente.value;

                    }

                    cache.delete(key);

          }

          const entry = {

                    value: null,

                    promise: null,

                    expiresAt: 0,

                    lastUsed: agora

          };

          const promise = Promise.resolve()

                    .then(loader)

                    .then(value => {

                              entry.value = value;

                              entry.promise = null;

                              entry.expiresAt = Date.now() + ttl;

                              entry.lastUsed = Date.now();

                              limparCacheAntigo(cache, limite);

                              return value;

                    })

                    .catch(error => {

                              if (cache.get(key) === entry) {

                                        cache.delete(key);

                              }

                              throw error;

                    });

          entry.promise = promise;

          cache.set(key, entry);

          return promise;

}

// ==================================================

// ENDPOINTS

// ==================================================

const endpoints = {

          live: {

                    items: "/api/live",

                    categories: "/api/live/categories",

                    title: "TV ao vivo"

          },

          movies: {

                    items: "/api/movies",

                    categories: "/api/movies/categories",

                    title: "Filmes"

          },

          series: {

                    items: "/api/series",

                    categories: "/api/series/categories",

                    title: "Séries"

          }

};

// ==================================================

// FUNÇÃO PARA EVITAR CACHE NAS CONSULTAS

// ==================================================

function adicionarParametroAntiCache(url) {

          const separador = url.includes("?") ? "&" : "?";

          return `${url}${separador}_lj=${Date.now()}`;

}

// ==================================================

// COMUNICAÇÃO COM O BACKEND

// ==================================================

async function apiFetch(url, options = {}) {

          const metodo = (options.method || "GET").toUpperCase();

          const endereco = metodo === "GET"

                    ? adicionarParametroAntiCache(url)

                    : url;

          const response = await fetch(endereco, {

                    ...options,

                    method: metodo,

                    credentials: "same-origin",

                    cache: "no-store",

                    headers: {

                              "Cache-Control": "no-cache",

                              "Pragma": "no-cache",

                              ...(options.headers || {})

                    }

          });

          if (response.status === 401) {

                    window.location.replace("/login.html");

                    throw new Error("Sua sessão expirou. Entre novamente.");

          }

          if (response.status === 304) {

                    throw new Error("O servidor retornou uma resposta em cache.");

          }

         if (!response.ok) {
    const error = new Error(`Erro HTTP ${response.status}`);
    error.status = response.status;
    throw error;
}

          const data = await response.json();

          if (data && data.erro) {

                    throw new Error(data.erro);

          }

          return data;

}

// ==================================================

// NORMALIZAR LISTAS

// ==================================================

async function enviarJSON(url, method, body) {
          return apiFetch(url, {
                    method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body || {})
          });
}

async function carregarBiblioteca() {
          try {
                    bibliotecaAtual = await apiFetch("/api/library");
                    bibliotecaAtual.favorites = Array.isArray(bibliotecaAtual.favorites) ? bibliotecaAtual.favorites : [];
                    bibliotecaAtual.progress = Array.isArray(bibliotecaAtual.progress) ? bibliotecaAtual.progress : [];
          } catch (error) {
                    console.error("Não foi possível carregar a biblioteca:", error);
                    bibliotecaAtual = { favorites: [], progress: [] };
          }
          return bibliotecaAtual;
}

function obterPoster(item) {
          return item?.stream_icon || item?.cover || item?.cover_big || item?.movie_image || item?.poster || "";
}

function adicionarSeloAcesso(poster, access) {
          const selo = criarElemento("span", `access-badge ${access === "free" ? "access-free" : "access-premium"}`, access === "free" ? "GRÁTIS" : "PREMIUM");
          poster.appendChild(selo);
}

function atualizarNavAtiva(page) {
          document.querySelectorAll(".nav-item").forEach(button => {
                    button.classList.toggle("active", button.dataset.page === page);
          });
}

function navegarPagina(page) {
          if (page === "favorites" || page === "continue") {
                    state.page = page;
                    state.requestId++;
                    atualizarNavAtiva(page);
                    const hero = document.getElementById("hero");
                    if (hero) hero.style.display = "none";
                    categorias.style.display = "none";
                    categorias.innerHTML = "";
                    titulo.textContent = page === "favorites" ? "Minha Lista" : "Continuar Assistindo";
                    renderizarBiblioteca(page);
                    return;
          }
          if (page === "subscription") {
                    atualizarNavAtiva(page);
                    mostrarTelaAssinatura();
                    return;
          }
          carregarPagina(page);
}

function criarNavegacaoExtra() {
          const nav = document.querySelector(".navigation");
          if (!nav) return;
          const itens = [
                    ["favorites", "♡ Minha Lista"],
                    ["continue", "▶ Continuar Assistindo"],
                    ["subscription", "✦ Assinatura"]
          ];
          itens.forEach(([page, label]) => {
                    if (document.querySelector(`[data-page="${page}"]`)) return;
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className = "nav-item";
                    button.dataset.page = page;
                    button.textContent = label;
                    button.addEventListener("click", () => navegarPagina(page));
                    nav.appendChild(button);
          });
}

async function alternarFavorito(tipo, id, tituloItem, poster) {
          const existente = bibliotecaAtual.favorites.find(item => item.type === tipo && String(item.id) === String(id));
          try {
                    if (existente) {
                              await apiFetch(`/api/library/favorites/${tipo}/${encodeURIComponent(id)}`, { method: "DELETE" });
                              exibirToast("Removido da Minha Lista.");
                    } else {
                              await enviarJSON("/api/library/favorites", "POST", { type: tipo, id: String(id), title: tituloItem, poster });
                              exibirToast("Adicionado à Minha Lista!");
                    }
                    await carregarBiblioteca();
                    if (state.page === "favorites") renderizarBiblioteca("favorites");
                    else if (["home", "live", "movies", "series"].includes(state.page)) renderizarCatalogo();
          } catch (error) {
                    exibirToast(error.message || "Não foi possível atualizar sua lista.");
          }
}

function renderizarBiblioteca(page) {
          const lista = page === "favorites" ? bibliotecaAtual.favorites : bibliotecaAtual.progress;
          const termo = (state.search || "").toLowerCase().trim();
          const filtrados = lista.filter(item => String(item.title || "").toLowerCase().includes(termo));
          contador.textContent = `${filtrados.length} conteúdos`;
          conteudo.replaceChildren();
          if (!filtrados.length) {
                    conteudo.innerHTML = `<div class="empty"><h3>${page === "favorites" ? "Sua lista está vazia" : "Nada para continuar"}</h3><p>${page === "favorites" ? "Adicione filmes e séries à Minha Lista." : "Os filmes e séries que você começar a assistir aparecerão aqui."}</p></div>`;
                    return;
          }
          const fragment = document.createDocumentFragment();
          filtrados.forEach(item => {
                    const card = document.createElement("article");
                    card.className = "card library-card";
                    const poster = document.createElement("div");
                    poster.className = "poster";
                    if (item.poster) {
                              const img = document.createElement("img");
                              img.src = item.poster; img.alt = item.title || "Conteúdo"; img.loading = "lazy";
                              img.onerror = () => poster.replaceChildren(criarPlaceholder(item.title || "Conteúdo"));
                              poster.appendChild(img);
                    } else poster.appendChild(criarPlaceholder(item.title || "Conteúdo"));
                    const h3 = criarElemento("h3", "", item.title || "Conteúdo");
                    const small = criarElemento("small", "", item.type === "series" ? "SÉRIE" : "FILME");
                    card.append(poster, h3, small);
                    if (page === "continue") {
                              const barra = document.createElement("div"); barra.className = "watch-progress";
                              const preenchimento = document.createElement("span"); preenchimento.style.width = `${Math.max(0, Math.min(100, Number(item.progressPercent) || 0))}%`;
                              barra.appendChild(preenchimento); card.appendChild(barra);
                              card.addEventListener("click", () => reproduzir(item.type === "series" ? "series" : "movie", item.id, item.extension || "mp4", item.title, { catalogId: item.parentSeriesId || item.id, resumePosition: Number(item.position) || 0, libraryType: item.type }));
                    } else {
                              const remover = criarElemento("button", "library-remove", "Remover da lista");
                              remover.type = "button";
                              remover.addEventListener("click", async event => {
                                        event.stopPropagation();
                                        await alternarFavorito(item.type, item.id, item.title, item.poster);
                              });
                              card.appendChild(remover);
                              card.addEventListener("click", () => {
                                        if (item.type === "series") abrirConteudo({ name: item.title, series_id: item.id, cover: item.poster }, item.id);
                                        else abrirConteudo({ name: item.title, stream_id: item.id, stream_icon: item.poster }, item.id);
                              });
                    }
                    fragment.appendChild(card);
          });
          conteudo.appendChild(fragment);
}

function salvarProgresso(video, forcar = false) {
          if (!reproduccaoAtual || !video || !Number.isFinite(video.duration) || video.duration <= 0) return;
          const agora = Date.now();
          if (!forcar && agora - ultimoSalvamentoProgresso < 15000) return;
          ultimoSalvamentoProgresso = agora;
          const contexto = reproduccaoAtual;
          const dados = {
                    type: contexto.libraryType, id: String(contexto.id), title: contexto.title, poster: contexto.poster || "",
                    position: Math.max(0, video.currentTime || 0), duration: video.duration, extension: contexto.extension, parentSeriesId: contexto.parentSeriesId || ""
          };
          enviarJSON("/api/library/progress", "POST", dados).then(async () => {
                    await carregarBiblioteca();
          }).catch(error => console.warn("Não foi possível salvar o progresso:", error));
}

function extrairLista(data) {

          if (Array.isArray(data)) return data;

          if (data && Array.isArray(data.items)) return data.items;

          if (data && Array.isArray(data.data)) return data.data;

          if (data && Array.isArray(data.result)) return data.result;

          throw new Error("Formato de dados inesperado recebido da API.");

}

// ==================================================

// CARREGAR CATÁLOGO

// ==================================================


async function carregarPagina(page = "home", categoryId = "", options = {}) {
    const catalogPage = page === "home" ? "movies" : page;
    const config = endpoints[catalogPage];

    if (!config) {
        console.error("Página não encontrada:", page);
        return;
    }

    state.page = page;
    state.catalog = catalogPage;
    state.categoryId = String(categoryId || "");
    state.visibleCount = CONFIG.pageSize;

    const request = ++state.requestId;

    document.querySelectorAll(".nav-item").forEach(button => {
        button.classList.toggle("active", button.dataset.page === page);
    });

    const hero = document.getElementById("hero");

    categorias.style.display = "flex";

    if (hero) {
        hero.style.display = page === "home" ? "flex" : "none";
    }

    titulo.textContent = page === "home" ? "Em destaque" : config.title;

    conteudo.innerHTML = `
        <div class="loading">Carregando conteúdo...</div>
    `;

    categorias.innerHTML = "";
    contador.textContent = "";

    const categoryKey = state.categoryId || "all";
    const itemsKey = `${catalogPage}:${categoryKey}`;
    const categoriesKey = catalogPage;

    if (options.forceRefresh) {
        caches.items.delete(itemsKey);
        caches.categories.delete(categoriesKey);
    }

    const query = state.categoryId
        ? "?category_id=" + encodeURIComponent(state.categoryId)
        : "";

    // Inicia as duas consultas independentemente.
    const categoriasPromise = obterComCache(
        caches.categories,
        categoriesKey,
        async () => extrairLista(
            await apiFetch(config.categories)
        ),
        CONFIG.cacheCategorias,
        6
    );

    try {
        // Espera somente os conteúdos principais.
        const items = await obterComCache(
            caches.items,
            itemsKey,
            async () => extrairLista(
                await apiFetch(config.items + query)
            ),
            CONFIG.cacheCatalogo,
            12
        );

        if (request !== state.requestId) return;

        state.items = items;
        state.search = "";

        if (pesquisa) {
            pesquisa.value = "";
        }

        // Exibe os conteúdos imediatamente.
        renderizarCatalogo();

        // Mostra "Todos" enquanto as categorias carregam.
        state.categories = [];
        renderizarCategorias();

        // Atualiza as categorias em segundo plano.
        categoriasPromise
            .then(cats => {
                if (request !== state.requestId) return;

                state.categories = cats;
                renderizarCategorias();
            })
            .catch(error => {
                console.warn(
                    "Não foi possível carregar as categorias:",
                    error
                );
            });

    } catch (error) {
        if (request !== state.requestId) return;

        console.error("Erro ao carregar catálogo:", error);

        conteudo.innerHTML = `
            <div class="empty">
                <h3>Não foi possível carregar</h3>
                <p>${error.message}</p>
                <button class="primary-button" id="tentar-novamente">
                    Tentar novamente
                </button>
            </div>
        `;

        categorias.innerHTML = "";
        contador.textContent = "";

        const tentar = document.getElementById("tentar-novamente");

        if (tentar) {
            tentar.addEventListener("click", () => {
                carregarPagina(
                    state.page,
                    state.categoryId,
                    { forceRefresh: true }
                );
            });
        }

        // Evita rejeição não tratada caso a consulta de categorias falhe.
        categoriasPromise.catch(() => {});
    }
}


// ==================================================

// CATEGORIAS

// ==================================================

function renderizarCategorias() {

          categorias.innerHTML = "";

          const todos = document.createElement("button");

          todos.className = "category" +

                    (state.categoryId === "" ? " active" : "");

          todos.textContent = "Todos";

          todos.addEventListener("click", () => {

                    carregarPagina(state.page);

          });

          categorias.appendChild(todos);

          state.categories.forEach(category => {

                    const id = String(category.category_id ?? "");

                    if (!id) return;

                    const button = document.createElement("button");

                    button.className = "category" +

                              (state.categoryId === id ? " active" : "");

                    button.textContent = category.category_name || "Categoria";

                    button.addEventListener("click", () => {

                              carregarPagina(state.page, id);

                    });

                    categorias.appendChild(button);

          });

}

// ==================================================

// PLACEHOLDER DE IMAGEM

// ==================================================

function criarPlaceholder(nome) {

          const div = document.createElement("div");

          div.className = "poster-placeholder";

          div.textContent = nome;

          return div;

}

// ==================================================

// RENDERIZAÇÃO DO CATÁLOGO

// ==================================================

function renderizarCatalogo() {

          const termo = state.search.toLowerCase().trim();

          const filtrados = state.items.filter(item => {

                    const nome = (item.name || "").toLowerCase();

                    return nome.includes(termo);

          });

          contador.textContent = `${filtrados.length} conteúdos`;

          conteudo.innerHTML = "";

          if (filtrados.length === 0) {

                    conteudo.innerHTML = `

                              <div class="empty">

                                        <h3>Nenhum conteúdo encontrado</h3>

                                        <p>Tente outra pesquisa ou categoria.</p>

                              </div>

                    `;

                    return;

          }

          const exibidos = filtrados.slice(0, state.visibleCount);

          const fragment = document.createDocumentFragment();

          exibidos.forEach(item => {

                    const nome = item.name || "Sem título";

                    const id = state.catalog === "series"

                              ? item.series_id

                              : item.stream_id;

                    const imagem =

                              item.stream_icon ||

                              item.cover ||

                              item.cover_big ||

                              item.movie_image ||

                              "";

                    const card = document.createElement("article");

                    card.className = "card";

                    const poster = document.createElement("div");

                    poster.className = "poster";

                    if (imagem) {

                              const img = document.createElement("img");

                              img.src = imagem;

                              img.alt = nome;

                              img.loading = "lazy";

                              img.decoding = "async";

                              img.onerror = () => {

                                        poster.replaceChildren(criarPlaceholder(nome));

                              };

                              poster.appendChild(img);

                    } else {

                              poster.appendChild(criarPlaceholder(nome));

                    }

                    const h3 = document.createElement("h3");

                    h3.textContent = nome;

                    const small = document.createElement("small");

                    small.textContent = {

                              live: "TV AO VIVO",

                              movies: "FILME",

                              series: "SÉRIE"

                    }[state.catalog];

                    adicionarSeloAcesso(poster, item.access);
                    card.append(poster, h3, small);
                    if (state.catalog !== "live" && id !== undefined && id !== null) {
                              const favorito = bibliotecaAtual.favorites.some(entry => entry.type === state.catalog && String(entry.id) === String(id));
                              const botaoFavorito = criarElemento("button", "favorite-toggle", favorito ? "♥" : "♡");
                              botaoFavorito.type = "button";
                              botaoFavorito.title = favorito ? "Remover da Minha Lista" : "Adicionar à Minha Lista";
                              botaoFavorito.addEventListener("click", event => {
                                        event.stopPropagation();
                                        alternarFavorito(state.catalog, id, nome, imagem);
                              });
                              card.appendChild(botaoFavorito);
                    }
                    card.addEventListener("click", () => abrirConteudo(item, id));

                    fragment.appendChild(card);

          });

          conteudo.appendChild(fragment);

          if (filtrados.length > state.visibleCount) {

                    const area = document.createElement("div");

                    area.style.gridColumn = "1 / -1";

                    area.style.display = "flex";

                    area.style.justifyContent = "center";

                    area.style.padding = "30px 0";

                    const botao = document.createElement("button");

                    botao.className = "primary-button";

                    botao.textContent = "Carregar mais conteúdos";

                    botao.addEventListener("click", () => {

                              state.visibleCount += CONFIG.pageSize;

                              renderizarCatalogo();

                    });

                    area.appendChild(botao);

                    conteudo.appendChild(area);

          }

}

// ==================================================

// MODAL

// ==================================================

function abrirModal() {

          modal.classList.add("open");

}

function criarElemento(tag, classe, texto) {

          const elemento = document.createElement(tag);

          if (classe) elemento.className = classe;

          if (texto !== undefined) elemento.textContent = texto;

          return elemento;

}

let activeHls = null;

// ==================================================

// PLAYER - LIMPEZA

// ==================================================

function limparPlayer() {

          const videoAtual = document.getElementById("video-player");
          if (videoAtual && reproduccaoAtual) salvarProgresso(videoAtual, true);
          reproduccaoAtual = null;

          if (activeHls) {

                    activeHls.destroy();

                    activeHls = null;

          }

          const video = document.getElementById("video-player");

          if (video) {

                    video.pause();

                    video.removeAttribute("src");

                    video.load();

          }

}

function fecharModal() {

          limparPlayer();

          modal.classList.remove("open");

          modalContent.classList.remove("player-modal");

}

// ==================================================

// EXIBIR DETALHES

// ==================================================

function mostrarDetalhes(nome, descricao, aviso = "") {

          limparPlayer();

          modalContent.classList.remove("player-modal");

          modalBody.replaceChildren();

          modalBody.appendChild(criarElemento("h2", "", nome));

          const paragrafo = criarElemento("p", "", descricao);

          paragrafo.style.whiteSpace = "pre-line";

          modalBody.appendChild(paragrafo);

          if (aviso) {

                    modalBody.appendChild(criarElemento("p", "", aviso));

          }

          abrirModal();

}
// ==================================================
// TELA DE BLOQUEIO LJ PREMIUM
// ==================================================

function mostrarBloqueioPremium(nome = "Conteúdo exclusivo") {
    limparPlayer();

    modalContent.classList.remove("player-modal");
    modalBody.replaceChildren();

    const container = criarElemento("div", "lj-premium-lock");

    const icone = criarElemento("div", "lj-premium-lock-icon", "♛");

    const etiqueta = criarElemento(
        "span",
        "lj-premium-lock-label",
        "CONTEÚDO EXCLUSIVO"
    );

    const tituloBloqueio = criarElemento(
        "h2",
        "lj-premium-lock-title",
        "Desbloqueie esse conteúdo!"
    );

    const descricao = criarElemento(
        "p",
        "lj-premium-lock-description",
        `O título "${nome}" é exclusivo para assinantes LJ PREMIUM. Assine agora e aproveite filmes, séries e muito mais!`
    );

    const beneficios = criarElemento(
        "div",
        "lj-premium-lock-benefits"
    );

    [
        "Acesso a conteúdos Premium",
        "Filmes e séries exclusivos",
        "30 dias de entretenimento"
    ].forEach(texto => {
        const item = criarElemento("div", "lj-premium-lock-benefit");
        item.textContent = "✓ " + texto;
        beneficios.appendChild(item);
    });

    const assinar = criarElemento(
        "button",
        "lj-premium-lock-button",
        "✦ ASSINAR LJ PREMIUM"
    );

    assinar.type = "button";

    assinar.addEventListener("click", () => {
        fecharModal();
        navegarPagina("subscription");
    });

    const voltar = criarElemento(
        "button",
        "lj-premium-lock-back",
        "Continuar navegando"
    );

    voltar.type = "button";
    voltar.addEventListener("click", fecharModal);

    container.append(
        icone,
        etiqueta,
        tituloBloqueio,
        descricao,
        beneficios,
        assinar,
        voltar
    );

    modalBody.appendChild(container);
    abrirModal();
}

// ==================================================

// ABRIR FILMES, SÉRIES E CANAIS

// ==================================================

async function abrirConteudo(item, id) {

          const tipo = state.catalog;

          const nome = item.name || "Conteúdo";

          if (tipo === "live") {

                    const extensao = item.container_extension === "ts"

                              ? "ts"

                              : "m3u8";

                    reproduzir("live", id, extensao, nome);

                    return;

          }

          if (!id) {

                    mostrarDetalhes(nome, "Não foi possível identificar este conteúdo.");

                    return;

          }

          mostrarDetalhes(nome, "Carregando informações...");

          try {

                    const endpoint = tipo === "movies"

                              ? `/api/movies/${encodeURIComponent(id)}`

                              : `/api/series/${encodeURIComponent(id)}`;

                    const dados = await obterComCache(

                              caches.details,

                              `${tipo}:${id}`,

                              () => apiFetch(endpoint),

                              CONFIG.cacheDetalhes,

                              40

                    );

                    if (tipo === "movies") {

                              exibirDetalhesFilme(item, dados);

                    } else {

                              exibirDetalhesSerie(item, dados);

                    }

         } catch (error) {

    console.error("Erro ao abrir conteúdo:", error);

    if (error.status === 403) {
        mostrarBloqueioPremium(nome);
        return;
    }

    mostrarDetalhes(nome, error.message);

}

}

// ==================================================

// EXTENSÕES

// ==================================================

function normalizarExtensao(extensao, fallback = "mp4") {

          const permitidas = [

                    "mp4", "mkv", "avi", "mov",

                    "ts", "flv", "wmv", "3gp"

          ];

          const ext = String(extensao || fallback)

                    .toLowerCase()

                    .replace(/^\./, "");

          return permitidas.includes(ext) ? ext : fallback;

}

// ==================================================

// FILMES

// ==================================================

function exibirDetalhesFilme(item, dados) {

          const info = dados.info || {};

          const movieData = dados.movie_data || {};

          const nome = info.name || item.name || "Filme";

          const extensao = normalizarExtensao(

                    movieData.container_extension ||

                    info.container_extension ||

                    item.container_extension,

                    "mp4"

          );

          const descricao = [

                    info.plot,

                    info.genre ? "Gênero: " + info.genre : "",

                    info.releaseDate ? "Lançamento: " + info.releaseDate : "",

                    info.rating ? "Nota: " + info.rating : "",

                    info.cast ? "Elenco: " + info.cast : ""

          ].filter(Boolean).join("\n\n");

          limparPlayer();

          modalContent.classList.remove("player-modal");

          modalBody.replaceChildren();

          modalBody.appendChild(criarElemento("h2", "", nome));

          if (descricao) {

                    const p = criarElemento("p", "", descricao);

                    p.style.whiteSpace = "pre-line";

                    modalBody.appendChild(p);

          }

          const botao = criarElemento(

                    "button",

                    "primary-button",

                    "▶ Assistir filme"

          );

          botao.addEventListener("click", () => {

                    reproduzir("movie", item.stream_id, extensao, nome);

          });

          modalBody.appendChild(botao);

          abrirModal();

}

// ==================================================

// SÉRIES E EPISÓDIOS

// ==================================================


function exibirDetalhesSerie(item, dados) {

    const info = dados.info || {};

    const nome = info.name || item.name || "Série";

    // Identificar o ID original da série
    const serieId = String(
        item.series_id ??
        item.id ??
        dados.series_id ??
        ""
    );

    if (!/^\d+$/.test(serieId)) {
        console.error("ID da série inválido:", item, dados);
        mostrarDetalhes(
            nome,
            "Não foi possível identificar esta série."
        );
        return;
    }

    const descricao = [
        info.plot,
        info.genre ? "Gênero: " + info.genre : "",
        info.releaseDate ? "Lançamento: " + info.releaseDate : "",
        info.rating ? "Nota: " + info.rating : ""
    ].filter(Boolean).join("\n\n");

    limparPlayer();

    modalContent.classList.remove("player-modal");
    modalBody.replaceChildren();

    modalBody.appendChild(
        criarElemento("h2", "", nome)
    );

    if (descricao) {
        const p = criarElemento("p", "", descricao);
        p.style.whiteSpace = "pre-line";
        modalBody.appendChild(p);
    }

    const lista = criarElemento("div", "episode-list");

    const temporadas = dados.episodes || {};

    const entradas = Array.isArray(temporadas)
        ? [["Episódios", temporadas]]
        : Object.entries(temporadas);

    if (entradas.length === 0) {
        lista.appendChild(
            criarElemento(
                "p",
                "",
                "Nenhum episódio disponível."
            )
        );
    }

    entradas.forEach(([temporada, episodios]) => {

        lista.appendChild(
            criarElemento(
                "h3",
                "season-title",
                `Temporada ${temporada}`
            )
        );

        if (!Array.isArray(episodios)) return;

        episodios.forEach(episodio => {

            // ID do arquivo de vídeo do episódio
            const episodioId =
                episodio.id ??
                episodio.stream_id ??
                episodio.episode_id;

            if (
                episodioId === undefined ||
                episodioId === null ||
                !/^\d+$/.test(String(episodioId))
            ) {
                console.warn(
                    "Episódio sem ID válido:",
                    episodio
                );
                return;
            }

            const numero = episodio.episode_num ?? "";

            const tituloEpisodio =
                episodio.title ||
                episodio.info?.name ||
                "Episódio";

            const extensao = normalizarExtensao(
                episodio.container_extension,
                "mp4"
            );

            const botao = criarElemento(
                "button",
                "episode-button",
                `▶ ${numero ? numero + " - " : ""}${tituloEpisodio}`
            );

            botao.addEventListener("click", () => {

                console.log("[LJ] Abrindo episódio:", {
                    serieId,
                    episodioId,
                    tituloEpisodio,
                    extensao
                });

                reproduzir(
                    "series",
                    String(episodioId),
                    extensao,
                    `${nome} - ${tituloEpisodio}`,
                    {
                        parentSeriesId: serieId,
                        libraryType: "series"
                    }
                );

            });

            lista.appendChild(botao);

        });

    });

    modalBody.appendChild(lista);

    abrirModal();
}

// ==================================================

// PLAYER DE VÍDEO

// ==================================================


function reproduzir(tipo, id, extensao, nome, options = {}) {
    // ==========================================
    // VALIDAR ID DO EPISÓDIO OU DA MÍDIA
    // ==========================================

    if (!id || !/^\d+$/.test(String(id))) {
        mostrarDetalhes(nome, "Identificador de mídia inválido.");
        return;
    }

    limparPlayer();

    modalContent.classList.add("player-modal");
    modalBody.replaceChildren();

    // ==========================================
    // MONTAR INTERFACE DO PLAYER
    // ==========================================

    const header = criarElemento("div", "player-header");
    header.appendChild(criarElemento("h2", "", nome));
    header.appendChild(
        criarElemento("p", "", "LJ STREAMING • REPRODUÇÃO")
    );

    const container = criarElemento("div", "video-container");

    const video = document.createElement("video");
    video.id = "video-player";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";

    container.appendChild(video);

    const mensagem = criarElemento(
        "div",
        "player-message",
        "Conectando ao servidor de mídia..."
    );

    modalBody.append(header, container, mensagem);

    abrirModal();

    // ==========================================
    // NORMALIZAR EXTENSÃO
    // ==========================================

    const ext = normalizarExtensao(
        extensao,
        tipo === "live" ? "m3u8" : "mp4"
    );

    // ==========================================
    // IDENTIFICAR A SÉRIE CORRETAMENTE
    // ==========================================

    const catalogId = String(
        options.parentSeriesId ||
        options.catalogId ||
        id
    );

    // ==========================================
    // MONTAR ENDEREÇO DO PLAYER
    // ==========================================

    let endereco =
        `/api/play/${encodeURIComponent(tipo)}/` +
        `${encodeURIComponent(id)}/` +
        `${encodeURIComponent(ext)}`;

    if (tipo === "series") {
        endereco +=
            `?series_id=${encodeURIComponent(catalogId)}`;
    }

    // ==========================================
    // REGISTRAR REPRODUÇÃO NA BIBLIOTECA
    // ==========================================

    reproduccaoAtual = tipo === "live" ? null : {
        id: String(id),

        libraryType:
            options.libraryType ||
            (tipo === "series" ? "series" : "movies"),

        title: nome,

        poster: options.poster || "",

        extension: ext,

        parentSeriesId:
            tipo === "series" ? catalogId : ""
    };

    ultimoSalvamentoProgresso = 0;

    // ==========================================
    // INICIAR REPRODUÇÃO
    // ==========================================

    const iniciar = () => {
        if (
            options.resumePosition > 0 &&
            Number.isFinite(video.duration)
        ) {
            try {
                video.currentTime = Math.min(
                    options.resumePosition,
                    Math.max(0, video.duration - 1)
                );
            } catch (error) {
                console.warn(
                    "Não foi possível retomar o vídeo:",
                    error
                );
            }
        }

        video.play().catch(() => {
            mensagem.textContent = "Clique em play para iniciar.";
        });
    };

    // ==========================================
    // REPRODUÇÃO HLS
    // ==========================================

    if (ext === "m3u8") {
        if (window.Hls && Hls.isSupported()) {

            activeHls = new Hls({
                enableWorker: true
            });

            activeHls.loadSource(endereco);
            activeHls.attachMedia(video);

            activeHls.on(
                Hls.Events.MANIFEST_PARSED,
                () => {
                    mensagem.textContent =
                        "Transmissão carregada. Iniciando...";

                    iniciar();
                }
            );

            activeHls.on(
                Hls.Events.ERROR,
                (event, data) => {
                    if (data.fatal) {
                        mensagem.textContent =
                            "Falha na transmissão. Verifique a disponibilidade do canal.";

                        console.error("Erro HLS:", data);

                        if (activeHls) {
                            activeHls.destroy();
                            activeHls = null;
                        }
                    }
                }
            );

        } else if (
            video.canPlayType(
                "application/vnd.apple.mpegurl"
            )
        ) {
            video.src = endereco;

            video.addEventListener(
                "loadedmetadata",
                iniciar,
                { once: true }
            );

        } else {
            mensagem.textContent =
                "Seu navegador não oferece suporte a HLS.";
        }

    } else {

        // ======================================
        // FILMES E EPISÓDIOS
        // ======================================

        video.src = endereco;

        video.addEventListener(
            "loadedmetadata",
            iniciar,
            { once: true }
        );

        video.load();
    }

    // ==========================================
    // EVENTOS DO PLAYER
    // ==========================================

    video.addEventListener("playing", () => {
        mensagem.textContent = "Reproduzindo agora.";
    });

    video.addEventListener("waiting", () => {
        mensagem.textContent = "Carregando vídeo...";
    });

    video.addEventListener("timeupdate", () => {
        salvarProgresso(video, false);
    });

    video.addEventListener("pause", () => {
        salvarProgresso(video, true);
    });

    video.addEventListener("ended", () => {
        salvarProgresso(video, true);
        reproduccaoAtual = null;
    });

    video.addEventListener("error", () => {
        mensagem.textContent =
            "Não foi possível reproduzir este conteúdo. Verifique o formato e a disponibilidade.";

        console.error(
            "Erro no vídeo:",
            video.error
        );
    });

    // ==========================================
    // DEBUG PARA TESTES
    // ==========================================

    console.log("[LJ PLAYER] Reprodução iniciada:", {
        tipo,
        id,
        seriesId: tipo === "series" ? catalogId : null,
        extensao: ext,
        endereco
    });
}


// ==================================================

// PESQUISA

// ==================================================

let searchTimer = null;

pesquisa.addEventListener("input", event => {

          state.search = event.target.value;

          state.visibleCount = CONFIG.pageSize;

          clearTimeout(searchTimer);

          searchTimer = setTimeout(() => {

                    if (state.page === "favorites" || state.page === "continue") renderizarBiblioteca(state.page);
                    else renderizarCatalogo();

          }, CONFIG.searchDelay);

});

// ==================================================

// NAVEGAÇÃO

// ==================================================

document.querySelectorAll(".nav-item").forEach(button => {

          button.addEventListener("click", () => {

                    navegarPagina(button.dataset.page);

          });

});

// ==================================================

// BOTÃO EXPLORAR

// ==================================================

document.getElementById("explorar").addEventListener("click", () => {

          document.getElementById("catalog-section").scrollIntoView({

                    behavior: "smooth"

          });

});

// ==================================================

// CONTROLES DO MODAL

// ==================================================

document.getElementById("fechar-modal").addEventListener(

          "click",

          fecharModal

);

modal.addEventListener("click", event => {

          if (event.target === modal) fecharModal();

});

document.addEventListener("keydown", event => {

          if (event.key === "Escape") fecharModal();

});

// ==================================================

// CONTA + LJ PREMIUM + PAGAMENTO PIX

// ==================================================

let assinaturaAtual = null;

let pagamentoAtual = null;

let temporizadorPagamento = null;

let verificacaoEmAndamento = false;

// ==================================================

// TOAST

// ==================================================

function exibirToast(mensagem) {

          const toast = document.getElementById("toast");

          if (!toast) return;

          toast.textContent = mensagem;

          toast.style.display = "block";

          setTimeout(() => {

                    toast.style.display = "none";

          }, 3500);

}

// ==================================================

// REQUISIÇÕES DE PAGAMENTO SEM CACHE

// ==================================================

async function requisicaoPagamento(url, options = {}) {

          const metodo = (options.method || "GET").toUpperCase();

          const endereco = metodo === "GET"

                    ? adicionarParametroAntiCache(url)

                    : url;

          const response = await fetch(endereco, {

                    ...options,

                    method: metodo,

                    credentials: "same-origin",

                    cache: "no-store",

                    headers: {

                              "Content-Type": "application/json",

                              "Cache-Control": "no-cache",

                              "Pragma": "no-cache",

                              ...(options.headers || {})

                    }

          });

          const data = await response.json().catch(() => ({}));

          if (response.status === 401) {

                    window.location.replace("/login.html");

                    throw new Error("Sua sessão expirou.");

          }

          if (response.status === 304) {

                    throw new Error("Resposta em cache.");

          }

          if (!response.ok || data.erro) {

                    throw new Error(data.erro || `Erro HTTP ${response.status}`);

          }

          return data;

}

// ==================================================

// CONSULTAR ASSINATURA

// ==================================================

async function consultarAssinatura() {

          assinaturaAtual = await requisicaoPagamento(

                    "/api/subscription/status"

          );

          return assinaturaAtual;

}

// ==================================================

// TELA DE ASSINATURA

// ==================================================

function mostrarTelaAssinatura() {

          const hero = document.getElementById("hero");

          if (hero) hero.style.display = "none";

          titulo.textContent = "Sua assinatura";

          categorias.style.display = "none";

          contador.textContent = "";

          conteudo.innerHTML = `

                    <div class="premium-container">

                              <div class="premium-card">

                                        <div class="premium-icon">✦</div>

                                        <span class="premium-label">

                                                  EXCLUSIVO LJ STREAMING

                                        </span>

                                        <h2>Conheça o <span>LJ PREMIUM</span></h2>

                                        <p class="premium-description">

                                                  Tenha acesso ao seu entretenimento favorito

                                                  em um só lugar.

                                        </p>

                                        <div class="premium-price">

                                                  <strong>R$ 10,00</strong>

                                                  <span>/ 30 dias</span>

                                        </div>

                                        <div class="premium-benefits">

                                                  <div>✓ TV ao vivo</div>

                                                  <div>✓ Filmes</div>

                                                  <div>✓ Séries</div>

                                                  <div>✓ Acesso durante 30 dias</div>

                                        </div>

                                        <button

                                                  class="premium-button"

                                                  id="btn-assinar"

                                                  type="button"

                                        >

                                                  Assinar agora com PIX

                                        </button>

                                        <small class="premium-security">

                                                  Pagamento processado com segurança pelo Mercado Pago.

                                        </small>

                              </div>

                    </div>

          `;

          document.getElementById("btn-assinar").addEventListener(

                    "click",

                    gerarPix

          );

}

// ==================================================

// GERAR PIX

// ==================================================

async function gerarPix() {

          const botao = document.getElementById("btn-assinar");

          if (botao) {

                    botao.disabled = true;

                    botao.textContent = "Gerando PIX...";

          }

          try {

                    const dados = await requisicaoPagamento(

                              "/api/payments/pix",

                              {

                                        method: "POST",

                                        body: JSON.stringify({})

                              }

                    );

                    if (!dados.paymentId || !dados.qrCode) {

                              throw new Error("O servidor não retornou os dados completos do PIX.");

                    }

                    pagamentoAtual = dados;

                    exibirModalPix(dados);

                    iniciarVerificacaoPagamento(dados.paymentId);

          } catch (error) {

                    console.error("Erro ao gerar PIX:", error);

                    exibirToast(error.message);

                    if (botao) {

                              botao.disabled = false;

                              botao.textContent = "Tentar novamente";

                    }

          }

}

// ==================================================

// MODAL PIX

// ==================================================

function exibirModalPix(dados) {

          limparPlayer();

          modalContent.classList.remove("player-modal");

          modalBody.replaceChildren();

          const tituloPix = criarElemento(

                    "h2",

                    "",

                    "Pagamento LJ PREMIUM"

          );

          const descricao = criarElemento(

                    "p",

                    "",

                    "Escaneie o QR Code com o aplicativo do seu banco ou copie o código PIX."

          );

          const valor = criarElemento("div", "pix-value", "R$ 10,00");

          const duracao = criarElemento(

                    "p",

                    "pix-duration",

                    "Plano LJ PREMIUM • 30 dias"

          );

          modalBody.append(tituloPix, descricao, valor, duracao);

          if (dados.qrCodeBase64) {

                    const imagem = document.createElement("img");

                    imagem.className = "pix-qrcode";

                    imagem.alt = "QR Code para pagamento PIX";

                    imagem.src = dados.qrCodeBase64.startsWith("data:")

                              ? dados.qrCodeBase64

                              : `data:image/png;base64,${dados.qrCodeBase64}`;

                    modalBody.appendChild(imagem);

          }

          const label = criarElemento(

                    "p",

                    "pix-label",

                    "PIX copia e cola"

          );

          const codigo = document.createElement("textarea");

          codigo.className = "pix-code";

          codigo.readOnly = true;

          codigo.value = dados.qrCode;

          codigo.rows = 4;

          const copiar = criarElemento(

                    "button",

                    "premium-button",

                    "Copiar código PIX"

          );

          copiar.type = "button";

          copiar.addEventListener("click", async () => {

                    try {

                              await navigator.clipboard.writeText(dados.qrCode);

                              copiar.textContent = "Código copiado!";

                              exibirToast("Código PIX copiado!");

                    } catch {

                              codigo.select();

                              document.execCommand("copy");

                              exibirToast("Código PIX copiado!");

                    }

          });

          const status = criarElemento(

                    "div",

                    "pix-status",

                    "Aguardando confirmação do pagamento..."

          );

          status.id = "pix-status";

          modalBody.append(label, codigo, copiar, status);

          if (dados.ticketUrl) {

                    const link = document.createElement("a");

                    link.href = dados.ticketUrl;

                    link.target = "_blank";

                    link.rel = "noopener noreferrer";

                    link.className = "pix-ticket";

                    link.textContent = "Abrir pagamento no Mercado Pago";

                    modalBody.appendChild(link);

          }

          abrirModal();

}

// ==================================================

// VERIFICAR PAGAMENTO AUTOMATICAMENTE

// ==================================================

function iniciarVerificacaoPagamento(paymentId) {

          pararVerificacaoPagamento();

          let tentativas = 0;

          const limite = 450;

          async function verificar() {

                    if (verificacaoEmAndamento) return;

                    if (tentativas >= limite) {

                              pararVerificacaoPagamento();

                              const status = document.getElementById("pix-status");

                              if (status) {

                                        status.textContent =

                                                  "Tempo de consulta encerrado. Consulte novamente mais tarde.";

                              }

                              return;

                    }

                    tentativas++;

                    verificacaoEmAndamento = true;

                    try {

                              const resultado = await requisicaoPagamento(

                                        `/api/payments/${encodeURIComponent(paymentId)}/status`

                              );

                              console.log("Status do PIX:", resultado);

                              if (resultado.assinaturaAtiva === true) {

                                        pararVerificacaoPagamento();

                                        exibirToast("Pagamento confirmado!");

                                        // Atualizar assinatura

                                        try {

                                                  assinaturaAtual = await consultarAssinatura();

                                        } catch (error) {

                                                  console.error("Erro ao atualizar assinatura:", error);

                                        }

                                        // Atualizar botão Premium

                                        const premium = document.getElementById("btn-premium-topo");

                                        if (premium) {

                                                  premium.textContent = "✦ Minha assinatura";

                                        }

                                        // Fechar completamente o modal PIX

                                        limparPlayer();

                                        modal.classList.remove("open");

                                        modalBody.replaceChildren();

                                        modalContent.classList.remove("player-modal");

                                        // Liberar interface

                                        categorias.style.display = "flex";

                                        const hero = document.getElementById("hero");

                                        if (hero) {

                                                  hero.style.display = "flex";

                                        }

                                        // Limpar cache

                                        caches.items.clear();

                                        caches.categories.clear();

                                        caches.details.clear();

                                        // Atualizar catálogo

                                        await carregarPagina("home", "", {

                                                  forceRefresh: true

                                        });

                                        exibirToast("Bem-vindo ao LJ PREMIUM!");

                                        return;

                              }

                              const status = document.getElementById("pix-status");

                              if (status) {

                                        const situacao = resultado.status || "pending";

                                        status.textContent =

                                                  situacao === "pending" ||

                                                  situacao === "created" ||

                                                  situacao === "action_required" ||

                                                  situacao === "processing"

                                                            ? "Aguardando confirmação do PIX..."

                                                            : `Status do pagamento: ${situacao}`;

                              }

                    } catch (error) {

                              console.error("Erro ao consultar PIX:", error);

                    } finally {

                              verificacaoEmAndamento = false;

                    }

                    temporizadorPagamento = setTimeout(verificar, 4000);

          }

          verificar();

}

// ==================================================

// PARAR VERIFICAÇÃO

// ==================================================

function pararVerificacaoPagamento() {

          if (temporizadorPagamento) {

                    clearTimeout(temporizadorPagamento);

                    temporizadorPagamento = null;

          }

          verificacaoEmAndamento = false;

}

// ==================================================

// BOTÃO LJ PREMIUM NO TOPO

// ==================================================

function adicionarBotaoAssinatura() {

          const topbar = document.querySelector(".topbar");

          if (!topbar || document.getElementById("btn-premium-topo")) {

                    return;

          }

          const botao = criarElemento(

                    "button",

                    "premium-top-button",

                    "✦ LJ PREMIUM"

          );

          botao.id = "btn-premium-topo";

          botao.addEventListener("click", async () => {

                    try {

                              assinaturaAtual = await consultarAssinatura();

                              if (assinaturaAtual.active) {

                                        exibirStatusAssinatura();

                              } else {

                                        mostrarTelaAssinatura();

                              }

                    } catch (error) {

                              console.error("Erro ao consultar assinatura:", error);

                              exibirToast("Não foi possível consultar sua assinatura.");

                    }

          });

          topbar.appendChild(botao);

}

// ==================================================

// STATUS DA ASSINATURA

// ==================================================

function exibirStatusAssinatura() {

          limparPlayer();

          modalContent.classList.remove("player-modal");

          modalBody.replaceChildren();

          const tituloStatus = criarElemento(

                    "h2",

                    "",

                    "Sua assinatura LJ PREMIUM"

          );

          const ativo = criarElemento(

                    "div",

                    "subscription-active",

                    "✓ Assinatura ativa"

          );

          const validade = assinaturaAtual?.expiresAt

                    ? new Date(assinaturaAtual.expiresAt).toLocaleString("pt-BR")

                    : "Não informada";

          const texto = criarElemento(

                    "p",

                    "",

                    `Seu acesso está liberado até: ${validade}`

          );

          modalBody.append(tituloStatus, ativo, texto);

          abrirModal();

}

// ==================================================

// INICIALIZAÇÃO DA CONTA

// ==================================================


async function inicializarConta() {
    try {
        const data = await apiFetch("/api/auth/me");
        const usuario = data.user;

        usuarioAtual = usuario;

        if (!usuario) {
            throw new Error("Usuário não encontrado na sessão.");
        }

        const perfil = document.querySelector(".user-profile");

        if (perfil) {
            perfil.textContent =
                `● ${usuario.username} • ${
                    usuario.role === "admin"
                        ? "Administrador"
                        : "Usuário"
                }`;
        }

        if (usuario.role === "admin") {
            const nav = document.querySelector(".navigation");

            if (
                nav &&
                !document.getElementById("admin-nav-button")
            ) {
                const adminButton = document.createElement("button");

                adminButton.id = "admin-nav-button";
                adminButton.className = "nav-item";
                adminButton.type = "button";
                adminButton.textContent = "⚙ Painel administrativo";

                adminButton.addEventListener("click", () => {
                    window.location.href = "/admin.html";
                });

                nav.appendChild(adminButton);
            }
        }

        if (!document.getElementById("logout-button")) {
            const logout = document.createElement("button");

            logout.id = "logout-button";
            logout.type = "button";
            logout.textContent = "Sair";
            logout.className = "logout-button";

            logout.addEventListener("click", async () => {
                try {
                    pararVerificacaoPagamento();

                    await apiFetch("/api/auth/logout", {
                        method: "POST"
                    });

                    window.location.replace("/login.html");
                } catch (error) {
                    console.error("Erro ao sair:", error);
                    exibirToast("Não foi possível encerrar a sessão.");
                }
            });

            document.querySelector(".topbar").appendChild(logout);
        }

        adicionarBotaoAssinatura();
        criarNavegacaoExtra();

        const premium = document.getElementById("btn-premium-topo");

        if (premium) {
            premium.textContent = "✦ Minha assinatura";
        }

        categorias.style.display = "flex";

        // Inicia o catálogo imediatamente após confirmar o usuário.
        carregarPagina("home");

        // Consulta assinatura e biblioteca em segundo plano.
        consultarAssinatura()
            .then(resultado => {
                assinaturaAtual = resultado;
            })
            .catch(error => {
                console.error(
                    "Erro ao consultar assinatura:",
                    error
                );
            });

        carregarBiblioteca()
            .then(() => {
                if (
                    ["home", "live", "movies", "series"].includes(state.page)
                ) {
                    renderizarCatalogo();
                }
            })
            .catch(error => {
                console.error(
                    "Erro ao carregar biblioteca:",
                    error
                );
            });

    } catch (error) {
        console.error("Erro na autenticação:", error);
        window.location.replace("/login.html");
    }
}


function adicionarEstilosBiblioteca() {
          if (document.getElementById("lj-library-styles")) return;
          const style = document.createElement("style"); style.id = "lj-library-styles";
          style.textContent = `
                    .poster { position: relative; }
                    .access-badge { position: absolute; top: 9px; left: 9px; z-index: 2; padding: 5px 8px; border-radius: 6px; font-size: 10px; font-weight: 800; letter-spacing: .4px; }
                    .access-free { background: #16a34a; color: #fff; }
                    .access-premium { background: #d6a637; color: #171717; }
                    .favorite-toggle { position: absolute; top: 8px; right: 8px; z-index: 3; width: 34px; height: 34px; border: 0; border-radius: 50%; background: rgba(10,14,24,.88); color: #ff5277; font-size: 22px; cursor: pointer; }
                    .library-remove { margin: 8px 10px 12px; padding: 8px 10px; border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
                    .watch-progress { height: 5px; margin: 8px 10px 12px; background: rgba(255,255,255,.18); border-radius: 9px; overflow: hidden; }
                    .watch-progress span { display: block; height: 100%; background: #e5b33b; }
          `;
          document.head.appendChild(style);
}

// ==================================================

// INICIAR SISTEMA

// ==================================================

adicionarEstilosBiblioteca();
inicializarConta();
