#ifndef SCRIPT_H
#define SCRIPT_H

#define SCRIPTDATA_COUNT (0x40000)
#define JUMPTABLE_COUNT  (0x4000)
#define FUNCTION_COUNT   (0x200)

#define JUMPSTACK_COUNT (0x400)
#define FUNCSTACK_COUNT (0x400)
#define FORSTACK_COUNT  (0x400)

#define RETRO_USE_COMPILER (1)

struct ScriptPtr {
    int scriptCodePtr;
    int jumpTablePtr;
};

struct ObjectScript {
    int frameCount;
    int spriteSheetID;
    ScriptPtr eventMain;
    ScriptPtr eventDraw;
    ScriptPtr eventStartup;
    int frameListOffset;
    AnimationFile *animFile;
};

struct ScriptEngine {
    int operands[0x10];
    int temp[8];
    int arrayPosition[9];
    int checkResult;
};

#if RETRO_USE_COMPILER
#define TABLE_COUNT       (0x200)
#define TABLE_ENTRY_COUNT (0x400)

struct StaticInfo {
    StaticInfo()
    {
        StrCopy(name, "");
        value   = 0;
        dataPos = SCRIPTDATA_COUNT - 1;
    }
    StaticInfo(const char *aliasName, int val)
    {
        StrCopy(name, aliasName);
        value   = val;
        dataPos = SCRIPTDATA_COUNT - 1;
    }

    char name[0x20];
    int value;
    int dataPos;
};

struct TableValue {
    TableValue()
    {
        value   = 0;
        dataPos = SCRIPTDATA_COUNT - 1;
    }
    TableValue(const char *aliasName, int val)
    {
        value   = val;
        dataPos = SCRIPTDATA_COUNT - 1;
    }

    int value;
    int dataPos;
};

struct TableInfo {
    TableInfo()
    {
        StrCopy(name, "");
        valueCount = 0;
        dataPos    = SCRIPTDATA_COUNT - 1;
    }
    TableInfo(const char *aliasName, int valCnt)
    {
        StrCopy(name, aliasName);
        valueCount = valCnt;
        dataPos    = SCRIPTDATA_COUNT - 1;
    }

    char name[0x20];
    int valueCount;
    TableValue values[TABLE_ENTRY_COUNT];
    int dataPos;
};
#endif

enum ScriptSubs { EVENT_MAIN = 0, EVENT_DRAW = 1, EVENT_SETUP = 2 };

extern ObjectScript objectScriptList[OBJECT_COUNT];
extern ScriptPtr functionScriptList[FUNCTION_COUNT];

extern int scriptData[SCRIPTDATA_COUNT];
extern int jumpTableData[JUMPTABLE_COUNT];

extern int jumpTableStack[JUMPSTACK_COUNT];
extern int functionStack[FUNCSTACK_COUNT];
extern int foreachStack[FORSTACK_COUNT];

extern int scriptCodePos; // Bytecode reading offset
extern int jumpTablePos;  // Bytecode reading offset
extern int jumpTableStackPos;
extern int functionStackPos;
extern int foreachStackPos;

extern ScriptEngine scriptEng;
extern char scriptText[0x4000];

#if !RETRO_USE_ORIGINAL_CODE
// Count of script stream problems since the last bytecode load. Non-zero means
// the data's opcode list does not match the engine's, which the page uses to
// pick a different one rather than making someone read a log to find out.
extern int scriptRangeErrors;

// Object type the script trace is restricted to, or -1 for all of them.
extern int scriptTraceObject;

// Log every input-variable read by any object, with the value it saw.
extern bool scriptTraceInput;

// Print each object's events as decoded opcodes once, at bytecode load.
extern bool scriptDisassemble;
#endif

extern int scriptDataPos;
#if !RETRO_USE_ORIGINAL_CODE
extern bool scriptTraceEnabled;
#endif
extern int scriptDataOffset;
extern int jumpTableDataPos;
extern int jumpTableDataOffset;

bool ConvertStringToInteger(const char *text, int *value);

#if RETRO_USE_COMPILER
extern int scriptFunctionCount;
extern char scriptFunctionNames[FUNCTION_COUNT][0x40];

extern int lineID;

void CheckAliasText(char *text);
void CheckStaticText(char *text);
TableInfo *CheckTableText(char *text);
void ConvertArithmaticSyntax(char *text);
void ConvertIfWhileStatement(char *text);
void ConvertForeachStatement(char *text);
bool ConvertSwitchStatement(char *text);
void ConvertFunctionText(char *text);
void CheckCaseNumber(char *text);
bool ReadSwitchCase(char *text);
void ReadTableValues(char *text);
void AppendIntegerToString(char *text, int value);
void AppendIntegerToStringW(ushort *text, int value);
void CopyAliasStr(char *dest, char *text, bool arrayIndex);
bool CheckOpcodeType(char *text); // Never actually used

void ParseScriptFile(char *scriptName, int scriptID);
#endif
void LoadBytecode(int stageListID, int scriptID);

void ProcessScript(int scriptCodePtr, int jumpTablePtr, byte scriptSub);

void ClearScriptData(void);

#endif // !SCRIPT_H