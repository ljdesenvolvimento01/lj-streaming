
"use strict";

const express = require("express");

function criarSistemaCatalogo({
    pool,
    consultarAPI,
    exigirAdministrador
}) {
    if (!pool) {
        throw new Error("Conexão PostgreSQL não fornecida ao catálogo.");
    }

    const router = express.Router();

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

    function validarTipo(tipo) {
        return Object.prototype.hasOwnProperty.call(TIPOS, tipo);
    }

    function validarId(id) {
        return typeof id === "string" && /^\d{1,20}$/.test(id);
    }

    function validarTipoBiblioteca(tipo) {
        return TIPOS_BIBLIOTECA.includes(tipo);
    }

    function chaveBiblioteca(tipo, id) {
        return `${tipo}:${id}`;
    }

    // ==================================================
    // CLASSIFICAÇÃO DO CATÁLOGO - POSTGRESQL
    // ==================================================

    async function obterClassificacao(tipo, id) {
        if (!validarTipo(tipo) || !validarId(String(id))) {
            return "premium";
        }

        const resultado = await pool.query(
            `SELECT classification
             FROM catalog_access
             WHERE type = $1 AND id = $2
             LIMIT 1`,
            [tipo, String(id)]
        );

        return resultado.rows[0]?.classification === "free"
            ? "free"
            : "premium";
    }

    async function podeAcessar(usuario, tipo, id, assinaturaAtiva) {
        if (!usuario) return false;

        if (usuario.role === "admin") return true;

        const classificacao = await obterClassificacao(tipo, String(id));

        if (classificacao === "free") return true;

        return Boolean(assinaturaAtiva);
    }

    async function adicionarClassificacao(tipo, itens) {
        if (!Array.isArray(itens)) return itens;

        if (!validarTipo(tipo)) {
            throw new Error("Tipo de conteúdo inválido.");
        }

        const resultado = await pool.query(
            `SELECT id
             FROM catalog_access
             WHERE type = $1 AND classification = 'free'`,
            [tipo]
        );

        const gratuitos = new Set(
            resultado.rows.map(item => String(item.id))
        );

        const idField = TIPOS[tipo].idField;

        return itens.map(item => {
            const id = item?.[idField];

            return {
                ...item,
                access: id !== undefined && id !== null &&
                    gratuitos.has(String(id))
                    ? "free"
                    : "premium"
            };
        });
    }

    async function definirClassificacao(tipo, id, access) {
        if (!validarTipo(tipo)) {
            throw new Error("Tipo de conteúdo inválido.");
        }

        if (!validarId(String(id))) {
            throw new Error("ID de conteúdo inválido.");
        }

        if (!["free", "premium"].includes(access)) {
            throw new Error("Classificação inválida.");
        }

        if (access === "free") {
            await pool.query(
                `INSERT INTO catalog_access (id, type, classification)
                 VALUES ($1, $2, 'free')
                 ON CONFLICT (id, type)
                 DO UPDATE SET classification = EXCLUDED.classification`,
                [String(id), tipo]
            );
        } else {
            await pool.query(
                `DELETE FROM catalog_access
                 WHERE id = $1 AND type = $2`,
                [String(id), tipo]
            );
        }

        return access;
    }

    // ==================================================
    // BIBLIOTECA DO USUÁRIO - POSTGRESQL
    // ==================================================

    async function obterBibliotecaUsuario(userId) {
        const resultado = await pool.query(
            `SELECT type, item_id, data
             FROM user_library
             WHERE user_id = $1`,
            [String(userId)]
        );

        const usuario = {
            favorites: [],
            progress: []
        };

        for (const linha of resultado.rows) {
            const item = {
                ...(linha.data || {}),
                id: String(linha.item_id),
                type: linha.type
            };

            if (linha.type === "favorite:movies" ||
                linha.type === "favorite:series") {
                usuario.favorites.push(item);
            }

            if (linha.type === "progress:movies" ||
                linha.type === "progress:series") {
                usuario.progress.push(item);
            }
        }

        return usuario;
    }

    async function salvarItemBiblioteca(userId, tipo, id, data) {
        await pool.query(
            `INSERT INTO user_library (user_id, type, item_id, data)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (user_id, type, item_id)
             DO UPDATE SET data = EXCLUDED.data`,
            [
                String(userId),
                tipo,
                String(id),
                JSON.stringify(data)
            ]
        );
    }

    async function removerItemBiblioteca(userId, tipo, id) {
        await pool.query(
            `DELETE FROM user_library
             WHERE user_id = $1 AND type = $2 AND item_id = $3`,
            [String(userId), tipo, String(id)]
        );
    }

    function obterUserId(req, res) {
        const userId = req.currentUser?.id;

        if (!userId) {
            res.status(401).json({
                erro: "Usuário não autenticado. Faça login novamente."
            });
            return null;
        }

        return String(userId);
    }

    // ==================================================
    // ADMINISTRAÇÃO DO CATÁLOGO
    // ==================================================

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

                const itens = await adicionarClassificacao(tipo, dados);

                return res.json({
                    tipo,
                    nome: configuracao.nome,
                    total: itens.length,
                    itens
                });
            } catch (error) {
                console.error("Erro ao listar catálogo administrativo:", error.message);

                return res.status(500).json({
                    erro: "Não foi possível carregar o catálogo."
                });
            }
        }
    );

    router.patch(
        "/admin/catalog/:type/:id",
        exigirAdministrador,
        async (req, res) => {
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

                const classificacao = await definirClassificacao(
                    tipo,
                    id,
                    access
                );

                return res.json({
                    sucesso: true,
                    tipo,
                    id,
                    access: classificacao,
                    mensagem: classificacao === "free"
                        ? "Conteúdo liberado gratuitamente."
                        : "Conteúdo definido como Premium."
                });
            } catch (error) {
                console.error("Erro ao alterar classificação:", error.message);

                return res.status(500).json({
                    erro: "Não foi possível alterar o conteúdo."
                });
            }
        }
    );

    // ==================================================
    // MINHA LISTA
    // ==================================================

    router.get("/library", async (req, res) => {
        try {
            const userId = obterUserId(req, res);
            if (!userId) return;

            const usuario = await obterBibliotecaUsuario(userId);

            return res.json({
                favorites: usuario.favorites,
                progress: usuario.progress
            });
        } catch (error) {
            console.error("Erro ao carregar biblioteca:", error.message);

            return res.status(500).json({
                erro: "Não foi possível carregar sua biblioteca."
            });
        }
    });

    // Adicionar favorito.

    router.post("/library/favorites", async (req, res) => {
        try {
            const userId = obterUserId(req, res);
            if (!userId) return;

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

            const tipoBanco = `favorite:${tipo}`;

            const existente = await pool.query(
                `SELECT data
                 FROM user_library
                 WHERE user_id = $1 AND type = $2 AND item_id = $3`,
                [userId, tipoBanco, id]
            );

            if (existente.rows.length) {
                return res.json({
                    sucesso: true,
                    mensagem: "Este conteúdo já está na sua lista.",
                    favorite: {
                        ...(existente.rows[0].data || {}),
                        id,
                        type: tipo
                    }
                });
            }

            const favorito = {
                id,
                type: tipo,
                title,
                poster: poster.slice(0, 2000),
                addedAt: new Date().toISOString()
            };

            await salvarItemBiblioteca(
                userId,
                tipoBanco,
                id,
                favorito
            );

            return res.status(201).json({
                sucesso: true,
                favorite: favorito
            });
        } catch (error) {
            console.error("Erro ao adicionar favorito:", error.message);

            return res.status(500).json({
                erro: "Não foi possível adicionar à sua lista."
            });
        }
    });

    // Remover favorito.

    router.delete(
        "/library/favorites/:type/:id",
        async (req, res) => {
            try {
                const userId = obterUserId(req, res);
                if (!userId) return;

                const tipo = req.params.type;
                const id = req.params.id;

                if (!validarTipoBiblioteca(tipo) || !validarId(id)) {
                    return res.status(400).json({
                        erro: "Conteúdo inválido."
                    });
                }

                const tipoBanco = `favorite:${tipo}`;

                const resultado = await pool.query(
                    `DELETE FROM user_library
                     WHERE user_id = $1 AND type = $2 AND item_id = $3`,
                    [userId, tipoBanco, id]
                );

                return res.json({
                    sucesso: true,
                    removido: resultado.rowCount > 0
                });
            } catch (error) {
                console.error("Erro ao remover favorito:", error.message);

                return res.status(500).json({
                    erro: "Não foi possível remover o favorito."
                });
            }
        }
    );

    // ==================================================
    // CONTINUAR ASSISTINDO
    // ==================================================

    router.post("/library/progress", async (req, res) => {
        try {
            const userId = obterUserId(req, res);
            if (!userId) return;

            const tipo = String(req.body?.type || "");
            const id = String(req.body?.id || "");
            const title = String(req.body?.title || "").trim();
            const poster = String(req.body?.poster || "").trim();

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

            const tipoBanco = `progress:${tipo}`;

            if (position / duration >= 0.95) {
                await removerItemBiblioteca(userId, tipoBanco, id);

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

            await salvarItemBiblioteca(
                userId,
                tipoBanco,
                id,
                progresso
            );

            return res.json({
                sucesso: true,
                progress: progresso
            });
        } catch (error) {
            console.error("Erro ao salvar progresso:", error.message);

            return res.status(500).json({
                erro: "Não foi possível salvar seu progresso."
            });
        }
    });

    // Remover progresso.

    router.delete(
        "/library/progress/:type/:id",
        async (req, res) => {
            try {
                const userId = obterUserId(req, res);
                if (!userId) return;

                const tipo = req.params.type;
                const id = req.params.id;

                if (!validarTipoBiblioteca(tipo) || !validarId(id)) {
                    return res.status(400).json({
                        erro: "Conteúdo inválido."
                    });
                }

                const tipoBanco = `progress:${tipo}`;

                const resultado = await pool.query(
                    `DELETE FROM user_library
                     WHERE user_id = $1 AND type = $2 AND item_id = $3`,
                    [userId, tipoBanco, id]
                );

                return res.json({
                    sucesso: true,
                    removido: resultado.rowCount > 0
                });
            } catch (error) {
                console.error("Erro ao remover progresso:", error.message);

                return res.status(500).json({
                    erro: "Não foi possível remover o progresso."
                });
            }
        }
    );

    return {
        router,
        obterClassificacao,
        podeAcessar,
        adicionarClassificacao,
        definirClassificacao
    };
}

module.exports = criarSistemaCatalogo;
