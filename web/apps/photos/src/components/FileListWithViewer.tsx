import type { RemotePullOpts } from "@/components/gallery";
import { downloadAndSaveFiles } from "@/services/save";
import { uploadManager } from "@/services/upload-manager";
import { fileTimelineDateString } from "@/utils/file";
import CheckIcon from "@mui/icons-material/Check";
import GridViewOutlinedIcon from "@mui/icons-material/GridViewOutlined";
import SortIcon from "@mui/icons-material/Sort";
import ViewListOutlinedIcon from "@mui/icons-material/ViewListOutlined";
import { IconButton, Menu, Tooltip, styled } from "@mui/material";
import { useColorScheme, useTheme } from "@mui/material/styles";
import { OverflowMenuOption } from "ente-base/components/OverflowMenu";
import type { AddSaveGroup } from "ente-gallery/components/utils/save-groups";
import {
    FileViewer,
    type FileViewerInitialSidebar,
    type FileViewerProps,
} from "ente-gallery/components/viewer/FileViewer";
import { sortFiles } from "ente-gallery/utils/file";
import type { Collection } from "ente-media/collection";
import type { EnteFile } from "ente-media/file";
import { fileFileName } from "ente-media/file-metadata";
import { moveToTrash } from "ente-new/photos/services/collection";
import type { CollectionSummary } from "ente-new/photos/services/collection-summary";
import { PseudoCollectionID } from "ente-new/photos/services/collection-summary";
import { usePhotosAppContext } from "ente-new/photos/types/context";
import { includes } from "ente-utils/type-guards";
import { t } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AutoSizer from "react-virtualized-auto-sizer";
import {
    FileList,
    type FileListAnnotatedFile,
    type FileListProps,
    type FileListViewMode,
} from "./FileList";

const fileListViewModes: FileListViewMode[] = ["grid", "list"];

/**
 * The order in which the files are shown.
 *
 * This is an explicit override of the order in which the gallery hands us the
 * files, which already reflects the album's own "Sort by" setting. Until the
 * user picks one of these, we leave that order alone.
 */
type FileSortBy = "date-desc" | "date-asc" | "name-asc" | "name-desc";

const fileSortBys: FileSortBy[] = [
    "date-desc",
    "date-asc",
    "name-asc",
    "name-desc",
];

// "IMG_2" should sort before "IMG_10", and case should not split the order.
const fileNameCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
});

const sortFilesBy = (files: EnteFile[], sortBy: FileSortBy) => {
    switch (sortBy) {
        case "date-desc":
            return sortFiles([...files]);
        case "date-asc":
            return sortFiles([...files], true);
        case "name-asc":
            return [...files].sort((a, b) =>
                fileNameCollator.compare(fileFileName(a), fileFileName(b)),
            );
        case "name-desc":
            return [...files].sort((a, b) =>
                fileNameCollator.compare(fileFileName(b), fileFileName(a)),
            );
    }
};

export type FileListWithViewerProps = {
    files: EnteFile[];
    onShowMap?: () => void;
    /**
     * If true, then controls to sort the files, and to switch between the
     * thumbnail grid and the file name list, are shown alongside the
     * {@link header}.
     *
     * Both choices are remembered across app restarts.
     */
    enableViewModeToggle?: boolean;
    enableDownload?: boolean;
    enableImageEditing?: boolean;
    onMarkTempDeleted?: (files: EnteFile[]) => void;
    onSetOpenFileViewer?: (open: boolean) => void;
    onRemotePull: (opts?: RemotePullOpts) => Promise<void>;
    activeCollectionSummary?: CollectionSummary;
    pendingFileIndex?: number;
    pendingFileSidebar?: FileViewerInitialSidebar;
    pendingHighlightCommentID?: string;
    onPendingNavigationConsumed?: () => void;
    onAddSaveGroup: AddSaveGroup;

    onAddFileToCollection?: (
        file: EnteFile,
        sourceCollectionSummaryID?: number,
    ) => void;
    onScroll?: (scrollOffset: number) => void;
    onVisibleDateChange?: (date: string | undefined) => void;
} & Pick<
    FileListProps,
    | "mode"
    | "modePlus"
    | "header"
    | "footer"
    | "disableGrouping"
    | "enableSelect"
    | "selected"
    | "setSelected"
    | "activeCollectionID"
    | "activePersonID"
    | "favoriteFileIDs"
    | "emailByUserID"
    | "listBorderRadius"
    | "onContextMenuAction"
    | "onContextMenuOpenChange"
    | "showAddPersonAction"
    | "showEditLocationAction"
    | "suppressSelectionUI"
> &
    Pick<
        FileViewerProps,
        | "user"
        | "isInIncomingSharedCollection"
        | "isInHiddenSection"
        | "fileNormalCollectionIDs"
        | "fileCollectionIDs"
        | "hiddenCollectionIDs"
        | "collectionSummaries"
        | "collectionNameByID"
        | "pendingFavoriteUpdates"
        | "pendingVisibilityUpdates"
        | "onRemoteFilesPull"
        | "onVisualFeedback"
        | "onToggleFavorite"
        | "onFileVisibilityUpdate"
        | "onSendLink"
        | "onSelectCollection"
        | "onSelectPerson"
    >;

export const FileListWithViewer: React.FC<FileListWithViewerProps> = ({
    mode,
    modePlus,
    header,
    footer,
    user,
    files,
    enableDownload,
    enableImageEditing = true,
    disableGrouping,
    enableSelect,
    selected,
    setSelected,
    activeCollectionID,
    activePersonID,
    activeCollectionSummary,
    favoriteFileIDs,
    emailByUserID,
    listBorderRadius,
    onContextMenuAction,
    onContextMenuOpenChange,
    showAddPersonAction,
    showEditLocationAction,
    suppressSelectionUI,
    isInIncomingSharedCollection,
    isInHiddenSection,
    fileNormalCollectionIDs,
    fileCollectionIDs,
    hiddenCollectionIDs,
    collectionSummaries,
    collectionNameByID,
    pendingFavoriteUpdates,
    pendingVisibilityUpdates,
    onSetOpenFileViewer,
    onRemotePull,
    onRemoteFilesPull,
    onVisualFeedback,
    onAddSaveGroup,
    onToggleFavorite,
    onFileVisibilityUpdate,
    onSendLink,
    onMarkTempDeleted,
    onSelectCollection,
    onSelectPerson,
    onAddFileToCollection,
    onScroll,
    onVisibleDateChange,
    pendingFileIndex,
    pendingFileSidebar,
    pendingHighlightCommentID,
    onPendingNavigationConsumed,
    onShowMap,
    enableViewModeToggle,
}) => {
    const [viewMode, setViewMode] = useFileListViewModeLocalState();
    const [sortBy, setSortBy] = useFileSortByLocalState();
    const [openSortMenu, setOpenSortMenu] = useState(false);
    const sortButtonRef = useRef<HTMLButtonElement | null>(null);
    const [openFileViewer, setOpenFileViewer] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [initialSidebar, setInitialSidebar] = useState<
        FileViewerInitialSidebar | undefined
    >(undefined);
    const [highlightCommentID, setHighlightCommentID] = useState<
        string | undefined
    >(undefined);
    const { showNotification } = usePhotosAppContext();
    const { mode: colorSchemeMode, systemMode } = useColorScheme();
    const theme = useTheme();
    const resolvedMode =
        colorSchemeMode === "system"
            ? systemMode
            : (colorSchemeMode ?? theme.palette.mode);
    const isDarkMode = resolvedMode === "dark";

    useEffect(() => {
        if (pendingFileIndex !== undefined) {
            setCurrentIndex(pendingFileIndex);
            setInitialSidebar(pendingFileSidebar);
            setHighlightCommentID(pendingHighlightCommentID);
            setOpenFileViewer(true);
            onSetOpenFileViewer?.(true);
            onPendingNavigationConsumed?.();
        }
    }, [
        pendingFileIndex,
        pendingFileSidebar,
        pendingHighlightCommentID,
        onSetOpenFileViewer,
        onPendingNavigationConsumed,
    ]);

    const handleCloseFileViewerInternal = useCallback(() => {
        setInitialSidebar(undefined);
        setHighlightCommentID(undefined);
        onSetOpenFileViewer?.(false);
        setOpenFileViewer(false);
    }, [onSetOpenFileViewer]);

    // The viewer steps through the same array the list renders, so both need
    // to see the same order.
    const sortedFiles = useMemo(
        () => (sortBy ? sortFilesBy(files, sortBy) : files),
        [files, sortBy],
    );

    // Sorted by name, consecutive files rarely share a date, so the grid's
    // date separators would degenerate into one per row.
    const isNameSort = sortBy == "name-asc" || sortBy == "name-desc";

    const annotatedFiles = useMemo(
        (): FileListAnnotatedFile[] =>
            sortedFiles.map((file) => ({
                file,
                timelineDateString: fileTimelineDateString(file),
            })),
        [sortedFiles],
    );

    const handleThumbnailClick = useCallback(
        (index: number) => {
            setCurrentIndex(index);
            setOpenFileViewer(true);
            onSetOpenFileViewer?.(true);
        },
        [onSetOpenFileViewer],
    );

    const handleTriggerRemotePull = useCallback(
        () => void onRemotePull({ source: "file-viewer-action" }),
        [onRemotePull],
    );

    const handleDownload = useCallback(
        (file: EnteFile) =>
            downloadAndSaveFiles([file], fileFileName(file), onAddSaveGroup),
        [onAddSaveGroup],
    );

    const handleDelete = useMemo(() => {
        return onMarkTempDeleted
            ? (file: EnteFile) =>
                  moveToTrash([file]).then(() => onMarkTempDeleted([file]))
            : undefined;
    }, [onMarkTempDeleted]);

    const handleSaveEditedImageCopy = useMemo(() => {
        if (!enableImageEditing) return undefined;
        return (
            editedFile: File,
            collection: Collection,
            enteFile: EnteFile,
        ) => {
            if (uploadManager.isUploadInProgress()) {
                showNotification({
                    color: "critical",
                    title: t("wait_for_active_upload_to_finish"),
                });
                return false;
            }
            uploadManager.prepareForNewUpload();
            uploadManager.showUploadProgressDialog();
            void uploadManager.uploadFile(editedFile, collection, enteFile);
            return true;
        };
    }, [enableImageEditing, showNotification]);

    const shouldShowMapButton =
        !!onShowMap &&
        modePlus !== "search" &&
        activeCollectionSummary?.type === "all" &&
        (activeCollectionSummary.fileCount > 0 || files.length > 0);

    const handleToggleViewMode = useCallback(
        () => setViewMode(viewMode == "grid" ? "list" : "grid"),
        [viewMode, setViewMode],
    );

    // Keep the menu's open state out of the header's identity, so that merely
    // opening it does not rebuild every row of the list.
    const handleOpenSortMenu = useCallback(() => setOpenSortMenu(true), []);
    const handleCloseSortMenu = useCallback(() => setOpenSortMenu(false), []);

    const handleSelectSortBy = useCallback(
        (sortBy: FileSortBy) => {
            setSortBy(sortBy);
            setOpenSortMenu(false);
        },
        [setSortBy],
    );

    const headerWithActions = useMemo(() => {
        if (!header || !(shouldShowMapButton || enableViewModeToggle)) {
            return header;
        }
        // The label describes the mode being switched to, not the current one.
        const viewModeLabel =
            viewMode == "grid" ? t("list_view") : t("grid_view");
        return {
            ...header,
            component: (
                <HeaderWithActions>
                    <HeaderMain>{header.component}</HeaderMain>
                    <HeaderActions>
                        {shouldShowMapButton && (
                            <Tooltip title={t("map")}>
                                <IconButton
                                    size="small"
                                    aria-label={t("map")}
                                    onClick={onShowMap}
                                >
                                    <MapIcon
                                        src="/images/gallery-globe/globe.svg"
                                        alt=""
                                        aria-hidden
                                        $isDarkMode={isDarkMode}
                                    />
                                </IconButton>
                            </Tooltip>
                        )}
                        {enableViewModeToggle && (
                            <Tooltip title={t("sort_by")}>
                                <IconButton
                                    ref={sortButtonRef}
                                    size="small"
                                    aria-label={t("sort_by")}
                                    onClick={handleOpenSortMenu}
                                >
                                    <SortIcon />
                                </IconButton>
                            </Tooltip>
                        )}
                        {enableViewModeToggle && (
                            <Tooltip title={viewModeLabel}>
                                <IconButton
                                    size="small"
                                    aria-label={viewModeLabel}
                                    onClick={handleToggleViewMode}
                                >
                                    {viewMode == "grid" ? (
                                        <ViewListOutlinedIcon />
                                    ) : (
                                        <GridViewOutlinedIcon />
                                    )}
                                </IconButton>
                            </Tooltip>
                        )}
                    </HeaderActions>
                </HeaderWithActions>
            ),
        };
    }, [
        header,
        isDarkMode,
        onShowMap,
        shouldShowMapButton,
        enableViewModeToggle,
        viewMode,
        handleToggleViewMode,
        handleOpenSortMenu,
    ]);

    return (
        <Container>
            <AutoSizer>
                {({ height, width }) => (
                    <FileList
                        {...{ width, height, annotatedFiles }}
                        {...{
                            mode,
                            modePlus,
                            header: headerWithActions,
                            footer,
                            user,
                            viewMode,
                            disableGrouping: disableGrouping || isNameSort,
                            enableSelect,
                            selected,
                            setSelected,
                            activeCollectionID,
                            activePersonID,
                            favoriteFileIDs,
                            emailByUserID,
                            listBorderRadius,
                            onScroll,
                            onVisibleDateChange,
                            collectionSummary: activeCollectionSummary,
                            onContextMenuAction,
                            onContextMenuOpenChange,
                            showAddPersonAction,
                            showEditLocationAction,
                            suppressSelectionUI,
                        }}
                        onItemClick={handleThumbnailClick}
                    />
                )}
            </AutoSizer>
            {enableViewModeToggle && (
                <FileSortByMenu
                    open={openSortMenu}
                    onClose={handleCloseSortMenu}
                    anchorEl={sortButtonRef.current}
                    sortBy={sortBy}
                    onSelectSortBy={handleSelectSortBy}
                />
            )}
            <FileViewer
                open={openFileViewer}
                onClose={handleCloseFileViewerInternal}
                initialIndex={currentIndex}
                initialSidebar={initialSidebar}
                highlightCommentID={highlightCommentID}
                disableDownload={!enableDownload}
                isInTrashSection={
                    activeCollectionID == PseudoCollectionID.trash
                }
                files={sortedFiles}
                {...{
                    user,
                    isInHiddenSection,
                    isInIncomingSharedCollection,
                    favoriteFileIDs,
                    fileNormalCollectionIDs,
                    fileCollectionIDs,
                    hiddenCollectionIDs,
                    collectionSummaries,
                    collectionNameByID,
                    pendingFavoriteUpdates,
                    pendingVisibilityUpdates,
                    onRemoteFilesPull,
                    onVisualFeedback,
                    onToggleFavorite,
                    onFileVisibilityUpdate,
                    onSendLink,
                    onSelectCollection,
                    onSelectPerson,
                }}
                isCommentsFeatureEnabled
                onTriggerRemotePull={handleTriggerRemotePull}
                onDownload={handleDownload}
                onDelete={handleDelete}
                onSaveEditedImageCopy={handleSaveEditedImageCopy}
                onAddFileToCollection={onAddFileToCollection}
                activeCollectionID={activeCollectionID}
            />
        </Container>
    );
};

const Container = styled("div")`
    flex: 1;
    width: 100%;
`;

const HeaderWithActions = styled("div")`
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
`;

const HeaderActions = styled("div")`
    display: flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    margin-left: auto;
`;

const HeaderMain = styled("div")`
    flex: 1;
    min-width: 0;
`;

/**
 * A state variable that syncs the chosen {@link FileListViewMode} to local
 * storage so that it survives reloads and app restarts.
 */
const useFileListViewModeLocalState = () => {
    const key = "fileListViewMode";

    const [value, setValue] = useState<FileListViewMode>("grid");

    // Read after mount; local storage is not available when prerendering.
    useEffect(() => {
        const value = localStorage.getItem(key);
        if (value && includes(fileListViewModes, value)) setValue(value);
    }, []);

    const setter = useCallback((value: FileListViewMode) => {
        localStorage.setItem(key, value);
        setValue(value);
    }, []);

    return [value, setter] as const;
};

/**
 * The chosen {@link FileSortBy}, synced to local storage. Undefined until the
 * user picks one, which leaves the gallery's own ordering untouched.
 */
const useFileSortByLocalState = () => {
    const key = "fileSortBy";

    const [value, setValue] = useState<FileSortBy | undefined>(undefined);

    // Read after mount; local storage is not available when prerendering.
    useEffect(() => {
        const value = localStorage.getItem(key);
        if (value && includes(fileSortBys, value)) setValue(value);
    }, []);

    const setter = useCallback((value: FileSortBy) => {
        localStorage.setItem(key, value);
        setValue(value);
    }, []);

    return [value, setter] as const;
};

interface FileSortByMenuProps {
    open: boolean;
    onClose: () => void;
    anchorEl: HTMLElement | null;
    sortBy: FileSortBy | undefined;
    onSelectSortBy: (sortBy: FileSortBy) => void;
}

const FileSortByMenu: React.FC<FileSortByMenuProps> = ({
    open,
    onClose,
    anchorEl,
    sortBy,
    onSelectSortBy,
}) => {
    const options: [FileSortBy, string][] = [
        ["date-desc", t("newest_first")],
        ["date-asc", t("oldest_first")],
        ["name-asc", `${t("name")} ${t("sort_asc_indicator")}`],
        ["name-desc", `${t("name")} ${t("sort_desc_indicator")}`],
    ];

    return (
        <Menu
            id="file-list-sort"
            anchorEl={anchorEl}
            open={open && !!anchorEl}
            onClose={onClose}
            slotProps={{
                list: {
                    disablePadding: true,
                    "aria-labelledby": "file-list-sort",
                },
            }}
            anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
            {options.map(([option, label]) => (
                <OverflowMenuOption
                    key={option}
                    onClick={() => onSelectSortBy(option)}
                    endIcon={sortBy == option ? <CheckIcon /> : undefined}
                >
                    {label}
                </OverflowMenuOption>
            ))}
        </Menu>
    );
};

const MapIcon = styled("img")<{ $isDarkMode: boolean }>(
    ({ theme, $isDarkMode }) => ({
        display: "block",
        width: 24,
        height: 24,
        filter:
            $isDarkMode || theme.palette.mode === "dark" ? "invert(1)" : "none",
    }),
);
