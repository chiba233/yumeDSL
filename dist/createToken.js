let tokenIdSeed = 0;
export const createToken = (token) => {
    return { ...token, id: `rt-${tokenIdSeed++}` };
};
export const resetTokenIdSeed = () => {
    tokenIdSeed = 0;
};
//# sourceMappingURL=createToken.js.map