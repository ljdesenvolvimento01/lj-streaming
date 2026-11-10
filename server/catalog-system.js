

"use strict";



const express = require("express");

const fs = require("fs");

const path = require("path");

const crypto = require("crypto");



function criarSistemaCatalogo({

    dataDir,

    consultarAPI,

    exigirAdministrador

}) {

    const router = express.Router();



    const ACCESS_FILE = path.join(dataDir, "catalog-access.json");

    const LIBRARY_FILE = path.join(dataDir, "user-library.json");



    // ==================================================

    // CONFIGURAÇÕES

    // ==================================================



    const TIPOS = {

        live: {

            action: "get_live_streams",

            idField: "stream_id",

            nome: "TV ao vivo"

        },

        movies: {

            action: "get_vod_streams",

            idField: "stream_id",

            nome: "Filmes"

        },

        series: {

            action: "get_series",

            idField: "series_id",

            nome: "Séries"

        }

    };



    const TIPOS_BIBLIOTECA = ["movies", "series"];



    // ==================================================

    // ARQUIVOS JSON

    // ==================================================



    function lerArquivo(arquivo, padrao) {

        try {

            if (!fs.existsSync(arquivo)) {

                return structuredClone(padrao);

            }



            const dados = JSON.parse(

                fs.readFileSync(arquivo, "utf8")

            );



            return dados;

        } catch (error) {

            console.error(

                `Erro ao ler ${path.basename(arquivo)}:`,

                error.message

            );



            throw new Error(

                `Não foi possível ler ${path.basename(arquivo)}.`

            );

        }

    }



    function salvarArquivo(arquivo, dados) {

        const temporario = arquivo + ".tmp";



        fs.writeFileSync(

            temporario,

            JSON.stringify(dados, null, 2),

            {

                encoding: "utf8",

                mode: 0o600

            }

        );



        try {

            fs.renameSync(temporario, arquivo);

        } catch (error) {

            if (fs.existsSync(temporario)) {

                fs.rmSync(temporario, { force: true });

            }



            throw error;

        }

    }



    function lerAcessos() {

        const dados = lerArquivo(ACCESS_FILE, {});



        if (

            !dados ||

            typeof dados !== "object" ||

            Array.isArray(dados)

        ) {

            throw new Error("Banco de acessos inválido.");

        }



        return dados;

    }



    function lerBiblioteca() {

        const dados = lerArquivo(LIBRARY_FILE, {});



        if (

            !dados ||

            typeof dados !== "object" ||

            Array.isArray(dados)

        ) {

            throw new Error("Banco da biblioteca inválido.");

        }



        return dados;

    }



    // ==================================================

    // VALIDAÇÕES

    // ==================================================



    function validarTipo(tipo) {

        return Object.prototype.hasOwnProperty.call(

            TIPOS,

            tipo

        );

    }



    function validarId(id) {

        return (

            typeof id === "string" &&

            /^\d{1,20}$/.test(id)

        );

    }



    function validarTipoBiblioteca(tipo) {

        return TIPOS_BIBLIOTECA.includes(tipo);

    }



    function chaveConteudo(tipo, id) {

        return `${tipo}:${id}`;

    }



    // ==================================================

    // CONTROLE DE ACESSO AO CATÁLOGO

    // ==================================================



    function obterClassificacao(tipo, id) {

        if (!validarTipo(tipo) || !validarId(String(id))) {

            return "premium";

        }



        const acessos = lerAcessos();

        const chave = chaveConteudo(tipo, String(id));



        // Todo conteúdo começa como PREMIUM.

        return acessos[chave] === "free"

            ? "free"

            : "premium";

    }



    function podeAcessar(usuario, tipo, id, assinaturaAtiva) {

        if (!usuario) return false;



        // Administrador possui acesso total.

        if (usuario.role === "admin") return true;



        // Conteúdo gratuito não exige assinatura.

        if (obterClassificacao(tipo, id) === "free") {

            return true;

        }



        // Conteúdo Premium exige assinatura ativa.

        return Boolean(assinaturaAtiva);

    }



  
function adicionarClassificacao(tipo, itens) {
    if (!Array.isArray(itens)) return itens;

    if (!validarTipo(tipo)) {
        throw new Error("Tipo de conteúdo inválido.");
    }

    // Lê o arquivo de acessos apenas uma vez.
    const acessos = lerAcessos();

    const idField = TIPOS[tipo].idField;

    return itens.map(item => {
        const id = item?.[idField];

        if (id === undefined || id === null) {
            return {
                ...item,
                access: "premium"
            };
        }

        const chave = chaveConteudo(tipo, String(id));

        return {
            ...item,
            access: acessos[chave] === "free"
                ? "free"
                : "premium"
        };
    });
}
function definirClassificacao(tipo, id, access) {
    if (!validarTipo(tipo)) {
        throw new Error("Tipo de conteúdo inválido.");
    }

    if (!validarId(String(id))) {
        throw new Error("ID de conteúdo inválido.");
    }

    if (!["free", "premium"].includes(access)) {
        throw new Error("Classificação inválida.");
    }

    const acessos = lerAcessos();
    const chave = chaveConteudo(tipo, String(id));

    if (access === "free") {
        acessos[chave] = "free";
    } else {
        delete acessos[chave];
    }

    salvarArquivo(ACCESS_FILE, acessos);

    return access;
}


    // ==================================================

    // IDENTIFICAÇÃO DA BIBLIOTECA DO USUÁRIO

    // ==================================================



    function obterBibliotecaUsuario(userId) {

        const biblioteca = lerBiblioteca();



        if (!biblioteca[userId]) {

            biblioteca[userId] = {

                favorites: [],

                progress: []

            };

        }



        if (!Array.isArray(biblioteca[userId].favorites)) {

            biblioteca[userId].favorites = [];

        }



        if (!Array.isArray(biblioteca[userId].progress)) {

            biblioteca[userId].progress = [];

        }



        return {

            biblioteca,

            usuario: biblioteca[userId]

        };

    }



    function chaveBiblioteca(tipo, id) {

        return `${tipo}:${id}`;

    }



    // ==================================================

    // ADMINISTRAÇÃO DO CATÁLOGO

    // ==================================================



    // Listar catálogo com classificação.

    router.get(
        "/admin/catalog/:type",

        exigirAdministrador,

        async (req, res) => {

            try {

                const tipo = req.params.type;



                if (!validarTipo(tipo)) {

                    return res.status(400).json({

                        erro: "Tipo de catálogo inválido."

                    });

                }



                const configuracao = TIPOS[tipo];



                const dados = await consultarAPI({

                    action: configuracao.action

                });



                if (!Array.isArray(dados)) {

                    return res.status(502).json({

                        erro: "O provedor retornou um catálogo inválido."

                    });

                }



                const itens = adicionarClassificacao(

                    tipo,

                    dados

                );



                res.json({

                    tipo,

                    nome: configuracao.nome,

                    total: itens.length,

                    itens

                });



            } catch (error) {

                console.error(

                    "Erro ao listar catálogo administrativo:",

                    error.message

                );



                res.status(500).json({

                    erro: "Não foi possível carregar o catálogo."

                });

            }

        }

    );



    // Alterar conteúdo entre GRÁTIS e PREMIUM.

    router.patch(

        "/admin/catalog/:type/:id",

        exigirAdministrador,

        (req, res) => {

            try {

                const tipo = req.params.type;

                const id = req.params.id;

                const access = req.body?.access;



                if (!validarTipo(tipo)) {

                    return res.status(400).json({

                        erro: "Tipo de catálogo inválido."

                    });

                }



                if (!validarId(id)) {

                    return res.status(400).json({

                        erro: "ID de conteúdo inválido."

                    });

                }



                if (!["free", "premium"].includes(access)) {

                    return res.status(400).json({

                        erro: "Informe access como free ou premium."

                    });

                }



                const classificacao = definirClassificacao(

                    tipo,

                    id,

                    access

                );



                res.json({

                    sucesso: true,

                    tipo,

                    id,

                    access: classificacao,

                    mensagem: classificacao === "free"

                        ? "Conteúdo liberado gratuitamente."

                        : "Conteúdo definido como Premium."

                });



            } catch (error) {

                console.error(

                    "Erro ao alterar classificação:",

                    error.message

                );



                res.status(500).json({

                    erro: "Não foi possível alterar o conteúdo."

                });

            }

        }

    );



    // ==================================================

    // MINHA LISTA

    // ==================================================



    // Buscar favoritos e progresso do usuário logado.

    
router.get("/library", (req, res) => {
    try {
        if (!req.currentUser || !req.currentUser.id) {
            return res.status(401).json({
                erro: "Usuário não autenticado. Faça login novamente."
            });
        }

        const userId = req.currentUser.id;

        const { biblioteca, usuario } =
            obterBibliotecaUsuario(userId);

        salvarArquivo(LIBRARY_FILE, biblioteca);

        res.json({
            favorites: usuario.favorites,
            progress: usuario.progress
        });

    } catch (error) {
        console.error(
            "Erro ao carregar biblioteca:",
            error.message
        );

        res.status(500).json({
            erro: "Não foi possível carregar sua biblioteca."
        });
    }
});


    // Adicionar filme ou série à Minha Lista.

    router.post("/library/favorites", (req, res) => {

        try {

            const userId = req.currentUser.id;



            const tipo = String(req.body?.type || "");

            const id = String(req.body?.id || "");

            const title = String(req.body?.title || "").trim();

            const poster = String(req.body?.poster || "").trim();



            if (

                !validarTipoBiblioteca(tipo) ||

                !validarId(id) ||

                !title ||

                title.length > 200

            ) {

                return res.status(400).json({

                    erro: "Dados do favorito inválidos."

                });

            }



            const { biblioteca, usuario } =

                obterBibliotecaUsuario(userId);



            const chave = chaveBiblioteca(tipo, id);



            const existente = usuario.favorites.find(

                item => chaveBiblioteca(item.type, item.id) === chave

            );



            if (existente) {

                return res.json({

                    sucesso: true,

                    mensagem: "Este conteúdo já está na sua lista.",

                    favorite: existente

                });

            }



            const favorito = {

                id,

                type: tipo,

                title,

                poster: poster.slice(0, 2000),

                addedAt: new Date().toISOString()

            };



            usuario.favorites.push(favorito);



            salvarArquivo(LIBRARY_FILE, biblioteca);



            res.status(201).json({

                sucesso: true,

                favorite: favorito

            });



        } catch (error) {

            console.error(

                "Erro ao adicionar favorito:",

                error.message

            );



            res.status(500).json({

                erro: "Não foi possível adicionar à sua lista."

            });

        }

    });



    // Remover da Minha Lista.

    router.delete(

        "/library/favorites/:type/:id",

        (req, res) => {

            try {

                const userId = req.currentUser.id;

                const tipo = req.params.type;

                const id = req.params.id;



                if (

                    !validarTipoBiblioteca(tipo) ||

                    !validarId(id)

                ) {

                    return res.status(400).json({

                        erro: "Conteúdo inválido."

                    });

                }



                const { biblioteca, usuario } =

                    obterBibliotecaUsuario(userId);



                const quantidadeAntes = usuario.favorites.length;



                usuario.favorites = usuario.favorites.filter(

                    item => !(

                        item.type === tipo &&

                        String(item.id) === id

                    )

                );



                salvarArquivo(LIBRARY_FILE, biblioteca);



                res.json({

                    sucesso: true,

                    removido: usuario.favorites.length < quantidadeAntes

                });



            } catch (error) {

                console.error(

                    "Erro ao remover favorito:",

                    error.message

                );



                res.status(500).json({

                    erro: "Não foi possível remover o favorito."

                });

            }

        }

    );



    // ==================================================

    // CONTINUAR ASSISTINDO

    // ==================================================



    // Salvar ou atualizar posição de reprodução.

    router.post("/library/progress", (req, res) => {

        try {

            const userId = req.currentUser.id;



            const tipo = String(req.body?.type || "");

            const id = String(req.body?.id || "");

            const title = String(req.body?.title || "").trim();

            const poster = String(req.body?.poster || "").trim();
            const extensionInformada = String(req.body?.extension || "mp4").toLowerCase();
            const parentSeriesId = String(req.body?.parentSeriesId || "");
            const extensoesPermitidas = ["mp4", "mkv", "avi", "mov", "ts", "flv", "wmv", "3gp"];

            const position = Number(req.body?.position);

            const duration = Number(req.body?.duration);



            if (

                !validarTipoBiblioteca(tipo) ||

                !validarId(id) ||

                !title ||

                title.length > 200 ||

                !Number.isFinite(position) ||

                !Number.isFinite(duration) ||

                position < 0 ||

                duration <= 0 ||

                position > duration

            ) {

                return res.status(400).json({

                    erro: "Dados de reprodução inválidos."

                });

            }



            const { biblioteca, usuario } =

                obterBibliotecaUsuario(userId);



            const chave = chaveBiblioteca(tipo, id);



            // Remove automaticamente quando chega a 95%.

            if (position / duration >= 0.95) {

                usuario.progress = usuario.progress.filter(

                    item => !(

                        item.type === tipo &&

                        String(item.id) === id

                    )

                );



                salvarArquivo(LIBRARY_FILE, biblioteca);



                return res.json({

                    sucesso: true,

                    concluido: true,

                    mensagem: "Conteúdo removido de Continuar Assistindo."

                });

            }



            const progresso = {

                id,

                type: tipo,

                title,

                poster: poster.slice(0, 2000),

                position,

                duration,

                progressPercent: Math.min(

                    100,

                    Math.round((position / duration) * 100)

                ),

                updatedAt: new Date().toISOString()

            };



            const indice = usuario.progress.findIndex(

                item => chaveBiblioteca(item.type, item.id) === chave

            );



            if (indice >= 0) {

                usuario.progress[indice] = progresso;

            } else {

                usuario.progress.push(progresso);

            }



            salvarArquivo(LIBRARY_FILE, biblioteca);



            res.json({

                sucesso: true,

                progress: progresso

            });



        } catch (error) {

            console.error(

                "Erro ao salvar progresso:",

                error.message

            );



            res.status(500).json({

                erro: "Não foi possível salvar seu progresso."

            });

        }

    });



    // Remover item de Continuar Assistindo.

    router.delete(

        "/library/progress/:type/:id",

        (req, res) => {

            try {

                const userId = req.currentUser.id;

                const tipo = req.params.type;

                const id = req.params.id;



                if (

                    !validarTipoBiblioteca(tipo) ||

                    !validarId(id)

                ) {

                    return res.status(400).json({

                        erro: "Conteúdo inválido."

                    });

                }



                const { biblioteca, usuario } =

                    obterBibliotecaUsuario(userId);



                const quantidadeAntes = usuario.progress.length;



                usuario.progress = usuario.progress.filter(

                    item => !(

                        item.type === tipo &&

                        String(item.id) === id

                    )

                );



                salvarArquivo(LIBRARY_FILE, biblioteca);



                res.json({

                    sucesso: true,

                    removido: usuario.progress.length < quantidadeAntes

                });



            } catch (error) {

                console.error(

                    "Erro ao remover progresso:",

                    error.message

                );



                res.status(500).json({

                    erro: "Não foi possível remover o progresso."

                });

            }

        }

    );



    // ==================================================

    // EXPORTAÇÕES

    // ==================================================



    return {

        router,

        obterClassificacao,

        podeAcessar,

        adicionarClassificacao,

        definirClassificacao

    };

}



module.exports = criarSistemaCatalogo;
