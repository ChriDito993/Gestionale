let clientiArchivio = [];
let pagamentiCorrenti = [];

function formatImportoEUR(value) {
    const number = parseImporto(value);
    return new Intl.NumberFormat("it-IT", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(number);
}

function parseImporto(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (value === null || value === undefined) return 0;

    let raw = String(value).trim();
    if (!raw) return 0;

    raw = raw.replace(/[€\s]/g, "");
    if (raw.includes(",") && raw.includes(".")) {
        raw = raw.replace(/\./g, "").replace(",", ".");
    } else if (raw.includes(",")) {
        raw = raw.replace(",", ".");
    }

    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatDataLocale(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString("it-IT");
}

function getMeseCorrenteYYYYMM() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    return `${today.getFullYear()}-${month}`;
}

function getDataCorrenteYYYYMMDD() {
    const today = new Date();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${today.getFullYear()}-${month}-${day}`;
}

function mostraEsitoPagamento(message, type = "success") {
    const esito = document.getElementById("pagamentoEsito");
    if (!esito) return;

    esito.textContent = message;
    esito.classList.remove("pagamenti-esito-success", "pagamenti-esito-error");
    esito.classList.add(type === "error" ? "pagamenti-esito-error" : "pagamenti-esito-success");
    esito.style.display = "block";
}

function nascondiEsitoPagamento() {
    const esito = document.getElementById("pagamentoEsito");
    if (!esito) return;
    esito.style.display = "none";
    esito.textContent = "";
}

function getClienteLabel(cliente) {
    return `${cliente?.nome || ""} ${cliente?.cognome || ""}`.replace(/\s+/g, " ").trim();
}

function normalizzaClienteLabel(value) {
    return (value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/\"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function aggiornaClienteSelezionatoDaInput() {
    const clienteInput = document.getElementById("pagamentoCliente");
    const clienteIdInput = document.getElementById("pagamentoClienteId");
    if (!clienteInput || !clienteIdInput) return;

    const query = normalizzaClienteLabel(clienteInput.value);
    if (!query) {
        clienteIdInput.value = "";
        return;
    }

    const match = clientiArchivio.find(cliente => normalizzaClienteLabel(getClienteLabel(cliente)) === query);
    clienteIdInput.value = match?.id ? String(match.id) : "";
}

function aggiornaStatoFormModifica(pagamento = null) {
    const formMeta = document.getElementById("pagamentoFormMeta");
    const pagamentoIdEdit = document.getElementById("pagamentoIdEdit");
    const btnSalva = document.getElementById("btnSalvaPagamento");
    const btnAnnulla = document.getElementById("btnAnnullaModificaPagamento");

    if (!pagamentoIdEdit || !btnSalva || !btnAnnulla || !formMeta) return;

    if (pagamento && pagamento.id) {
        pagamentoIdEdit.value = String(pagamento.id);
        btnSalva.textContent = "Aggiorna";
        btnAnnulla.style.display = "inline-flex";
        formMeta.textContent = `Stai modificando il pagamento di ${pagamento.cliente || "cliente"}`;
        formMeta.style.display = "block";
    } else {
        pagamentoIdEdit.value = "";
        btnSalva.textContent = "Salva";
        btnAnnulla.style.display = "none";
        formMeta.textContent = "";
        formMeta.style.display = "none";
    }
}

function resetFormPagamento() {
    const form = document.getElementById("pagamentoForm");
    const clienteIdInput = document.getElementById("pagamentoClienteId");
    const dataInput = document.getElementById("pagamentoData");

    if (form) form.reset();
    if (clienteIdInput) clienteIdInput.value = "";
    if (dataInput && !dataInput.value) dataInput.value = getDataCorrenteYYYYMMDD();

    aggiornaStatoFormModifica(null);
}

function entraInModificaPagamento(pagamento) {
    const clienteInput = document.getElementById("pagamentoCliente");
    const clienteIdInput = document.getElementById("pagamentoClienteId");
    const importoInput = document.getElementById("pagamentoImporto");
    const dataInput = document.getElementById("pagamentoData");
    const noteInput = document.getElementById("pagamentoNote");

    if (!clienteInput || !clienteIdInput || !importoInput || !dataInput || !noteInput) return;

    clienteInput.value = pagamento?.cliente || "";
    importoInput.value = parseImporto(pagamento?.importo) || "";
    dataInput.value = pagamento?.data_pagamento || "";
    noteInput.value = pagamento?.note || "";

    aggiornaClienteSelezionatoDaInput();
    aggiornaStatoFormModifica(pagamento);
    mostraEsitoPagamento("Modalita modifica attiva.");
}

function getPagamentoById(pagamentoId) {
    const id = String(pagamentoId || "").trim();
    if (!id) return null;
    return pagamentiCorrenti.find(pagamento => String(pagamento?.id || "") === id) || null;
}

async function caricaClientiArchivio() {
    const clientiList = document.getElementById("pagamentoClientiList");
    if (!clientiList) return;

    try {
        const response = await fetch("/api/clienti", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) return;

        clientiArchivio = Array.isArray(data) ? data : [];
        clientiArchivio.sort((a, b) => {
            const aLabel = `${a.cognome || ""} ${a.nome || ""}`.trim().toLowerCase();
            const bLabel = `${b.cognome || ""} ${b.nome || ""}`.trim().toLowerCase();
            return aLabel.localeCompare(bLabel);
        });

        clientiList.innerHTML = "";

        clientiArchivio.forEach(cliente => {
            const option = document.createElement("option");
            option.value = getClienteLabel(cliente);
            clientiList.appendChild(option);
        });
    } catch (_error) {
        clientiArchivio = [];
        clientiList.innerHTML = "";
    }
}

async function caricaPagamentiMese(mese) {
    const body = document.getElementById("pagamentiBody");
    const empty = document.getElementById("statoVuoto");
    const totale = document.getElementById("totale");

    if (!body || !empty || !totale) return;

    body.innerHTML = "";
    empty.style.display = "none";
    totale.textContent = "Totale mese: € 0,00";
    pagamentiCorrenti = [];

    if (!mese) return;

    try {
        const response = await fetch(`/api/pagamenti/mese?mese=${encodeURIComponent(mese)}`, {
            cache: "no-store"
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || "Errore caricamento pagamenti");
        }

        const pagamenti = Array.isArray(data) ? data : [];
        pagamentiCorrenti = pagamenti;

        let totaleMese = 0;

        pagamenti.forEach(pagamento => {
            const importo = parseImporto(pagamento.importo);
            totaleMese += importo;

            const pagamentoId = pagamento?.id ? String(pagamento.id) : "";
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td>${escapeHtml(pagamento.cliente || "-")}</td>
                <td>${escapeHtml(formatDataLocale(pagamento.data_pagamento))}</td>
                <td>${escapeHtml(formatImportoEUR(importo))}</td>
                <td>${escapeHtml(pagamento.note || "-")}</td>
                <td class="pagamenti-actions-cell">
                    ${pagamentoId ? `
                        <button type="button" class="btn-apple-ghost pagamenti-action-btn" data-action="edit" data-id="${escapeHtml(pagamentoId)}">Modifica</button>
                        <button type="button" class="btn-apple-ghost pagamenti-action-btn pagamenti-action-danger" data-action="delete" data-id="${escapeHtml(pagamentoId)}">Elimina</button>
                    ` : "-"}
                </td>
            `;
            body.appendChild(tr);
        });

        totale.textContent = `Totale mese: ${formatImportoEUR(totaleMese)}`;

        if (!pagamenti.length) {
            empty.style.display = "block";
        }
    } catch (_error) {
        empty.style.display = "block";
    }
}

async function salvaPagamento(event) {
    event.preventDefault();

    const clienteInput = document.getElementById("pagamentoCliente");
    const clienteIdInput = document.getElementById("pagamentoClienteId");
    const importoInput = document.getElementById("pagamentoImporto");
    const dataInput = document.getElementById("pagamentoData");
    const noteInput = document.getElementById("pagamentoNote");
    const meseInput = document.getElementById("mese");
    const btn = document.getElementById("btnSalvaPagamento");
    const pagamentoIdEdit = document.getElementById("pagamentoIdEdit");

    if (!clienteInput || !clienteIdInput || !importoInput || !dataInput || !noteInput || !meseInput || !btn || !pagamentoIdEdit) return;

    aggiornaClienteSelezionatoDaInput();
    const clienteNome = clienteInput.value.trim();
    const clienteId = clienteIdInput.value.trim();
    const isModifica = Boolean(pagamentoIdEdit.value.trim());

    const payload = {
        cliente_id: clienteId || null,
        cliente: clienteNome,
        importo: importoInput.value,
        data_pagamento: dataInput.value,
        note: noteInput.value.trim()
    };

    if (!payload.cliente || !payload.importo || !payload.data_pagamento) {
        mostraEsitoPagamento("Compila cliente, importo e data.", "error");
        return;
    }

    btn.disabled = true;

    try {
        const endpoint = isModifica
            ? `/api/pagamenti/${encodeURIComponent(pagamentoIdEdit.value.trim())}`
            : "/api/pagamenti";

        const response = await fetch(endpoint, {
            method: isModifica ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || "Errore salvataggio pagamento");
        }

        mostraEsitoPagamento(isModifica ? "Pagamento aggiornato con successo." : "Pagamento salvato con successo.");
        resetFormPagamento();

        const mesePagamento = payload.data_pagamento.slice(0, 7);
        if (mesePagamento) {
            meseInput.value = mesePagamento;
        }

        await caricaPagamentiMese(meseInput.value);
    } catch (error) {
        mostraEsitoPagamento(error.message || "Errore salvataggio pagamento", "error");
    } finally {
        btn.disabled = false;
    }
}

async function eliminaPagamento(pagamentoId) {
    const meseInput = document.getElementById("mese");
    const pagamentoIdEdit = document.getElementById("pagamentoIdEdit");

    if (!meseInput) return;

    const conferma = window.confirm("Vuoi eliminare questo pagamento?");
    if (!conferma) return;

    try {
        const response = await fetch(`/api/pagamenti/${encodeURIComponent(String(pagamentoId || ""))}`, {
            method: "DELETE"
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || "Errore eliminazione pagamento");
        }

        if (pagamentoIdEdit && pagamentoIdEdit.value === String(pagamentoId)) {
            resetFormPagamento();
        }

        mostraEsitoPagamento("Pagamento eliminato con successo.");
        await caricaPagamentiMese(meseInput.value);
    } catch (error) {
        mostraEsitoPagamento(error.message || "Errore eliminazione pagamento", "error");
    }
}

function gestisciClickTabellaPagamenti(event) {
    const button = event.target.closest("button[data-action][data-id]");
    if (!button) return;

    const pagamentoId = button.getAttribute("data-id");
    const action = button.getAttribute("data-action");

    if (!pagamentoId || !action) return;

    if (action === "edit") {
        const pagamento = getPagamentoById(pagamentoId);
        if (!pagamento) {
            mostraEsitoPagamento("Pagamento non trovato.", "error");
            return;
        }
        entraInModificaPagamento(pagamento);
        return;
    }

    if (action === "delete") {
        eliminaPagamento(pagamentoId);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const meseInput = document.getElementById("mese");
    const pagamentoForm = document.getElementById("pagamentoForm");
    const dataInput = document.getElementById("pagamentoData");
    const clienteInput = document.getElementById("pagamentoCliente");
    const btnAnnulla = document.getElementById("btnAnnullaModificaPagamento");
    const pagamentiBody = document.getElementById("pagamentiBody");

    if (!meseInput) return;

    meseInput.value = getMeseCorrenteYYYYMM();
    caricaPagamentiMese(meseInput.value);
    caricaClientiArchivio();

    if (dataInput) {
        dataInput.value = getDataCorrenteYYYYMMDD();
    }

    if (clienteInput) {
        clienteInput.addEventListener("input", aggiornaClienteSelezionatoDaInput);
        clienteInput.addEventListener("change", aggiornaClienteSelezionatoDaInput);
        clienteInput.addEventListener("blur", aggiornaClienteSelezionatoDaInput);
    }

    meseInput.addEventListener("change", () => {
        resetFormPagamento();
        nascondiEsitoPagamento();
        caricaPagamentiMese(meseInput.value);
    });

    if (btnAnnulla) {
        btnAnnulla.addEventListener("click", () => {
            resetFormPagamento();
            mostraEsitoPagamento("Modifica annullata.");
        });
    }

    if (pagamentiBody) {
        pagamentiBody.addEventListener("click", gestisciClickTabellaPagamenti);
    }

    if (pagamentoForm) {
        pagamentoForm.addEventListener("submit", salvaPagamento);
    }
});
